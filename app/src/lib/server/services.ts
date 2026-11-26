import "server-only";
import { serverEnv } from "./env";
import { clientIp, rateLimit, tooMany } from "./rateLimit";

/** Proxy a GET to the services API (Fastify, services/src/api) with the keeper token. The browser never sees
 *  the token or the services URL. Responses are cached by Next for `revalidate` seconds. */
export async function proxyServices(req: Request, path: string, revalidate: number, limitPerMin = 120): Promise<Response> {
  const rl = rateLimit(`svc:${clientIp(req)}`, limitPerMin, 60);
  if (!rl.ok) return tooMany(rl.retryAfter);
  const url = `${serverEnv.servicesUrl()}/${path.replace(/^\//, "")}`;
  const token = serverEnv.keeperToken();
  try {
    const res = await fetch(url, {
      headers: { accept: "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      next: { revalidate },
      signal: AbortSignal.timeout(8000),
    });
    const body = await res.text();
    return new Response(body, {
      status: res.status,
      headers: {
        "content-type": res.headers.get("content-type") ?? "application/json",
        "cache-control": `public, s-maxage=${revalidate}, stale-while-revalidate=${revalidate * 2}`,
      },
    });
  } catch {
    return Response.json({ offline: true, error: "services_unreachable" }, { status: 503, headers: { "cache-control": "no-store" } });
  }
}

/** Server-side fetch of JSON from the services API (used by server routes that combine data). */
export async function servicesJson<T>(path: string, init?: RequestInit & { revalidate?: number }): Promise<T | null> {
  const token = serverEnv.keeperToken();
  try {
    const res = await fetch(`${serverEnv.servicesUrl()}/${path.replace(/^\//, "")}`, {
      ...init,
      headers: { accept: "application/json", "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}), ...(init?.headers ?? {}) },
      ...(init?.method && init.method !== "GET" ? { cache: "no-store" as const } : { next: { revalidate: init?.revalidate ?? 30 } }),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

export function joinPath(parts: string[] | undefined, search: string): string {
  const safe = (parts ?? []).map((p) => encodeURIComponent(p)).join("/");
  return search ? `${safe}${search}` : safe;
}
