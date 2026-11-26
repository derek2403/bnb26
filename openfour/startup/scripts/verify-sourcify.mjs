// Usage: node sourcify-v2.mjs <build-info.json> <chainId> <address>=<path:Name> ...
// Submits each contract to Sourcify API v2 (std JSON input) and polls the job.
import { readFileSync } from "node:fs";

const [bi, chainId, ...pairs] = process.argv.slice(2);
const info = JSON.parse(readFileSync(bi, "utf8"));
const UA = { "User-Agent": "splitstock-verify/1.0", "Content-Type": "application/json" };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

for (const p of pairs) {
  const [address, contractIdentifier] = p.split("=");
  const status = await fetch(`https://sourcify.dev/server/v2/contract/${chainId}/${address}`, { headers: UA }).then((r) => r.json()).catch(() => ({}));
  if (status.match) {
    console.log(`${address} ${contractIdentifier}: already ${status.match}`);
    continue;
  }
  const res = await fetch(`https://sourcify.dev/server/v2/verify/${chainId}/${address}`, {
    method: "POST",
    headers: UA,
    body: JSON.stringify({ stdJsonInput: info.input, compilerVersion: info.solcLongVersion, contractIdentifier }),
  });
  const body = await res.json();
  if (!body.verificationId) {
    console.log(`${address} ${contractIdentifier}: submit failed ${res.status} ${JSON.stringify(body).slice(0, 300)}`);
    continue;
  }
  let job;
  for (let i = 0; i < 60; i++) {
    await sleep(5000);
    job = await fetch(`https://sourcify.dev/server/v2/verify/${body.verificationId}`, { headers: UA }).then((r) => r.json());
    if (job.isJobCompleted) break;
  }
  const c = job?.contract ?? {};
  console.log(`${address} ${contractIdentifier}: ${job?.isJobCompleted ? (c.match ?? "no match") : "timeout"} ${job?.error ? JSON.stringify(job.error).slice(0, 300) : ""}`);
}
