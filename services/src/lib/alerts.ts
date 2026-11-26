import { env } from "../config/env.js";
import { errMsg, logger } from "./log.js";

const log = logger("alerts");
const lastSent = new Map<string, number>();

/**
 * Telegram alert with per-key de-duplication (default: at most one message per key per 30 min).
 * Never include secrets in `text`.
 */
export async function alert(key: string, text: string, minIntervalMs = 30 * 60_000): Promise<void> {
  const now = Date.now();
  const prev = lastSent.get(key) ?? 0;
  if (now - prev < minIntervalMs) return;
  lastSent.set(key, now);
  log.warn("alert", { key, text });
  const { TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID } = env();
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
  try {
    const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: `[SplitStock] ${text}`, disable_web_page_preview: true }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) log.warn("telegram send failed", { status: res.status });
  } catch (e) {
    log.warn("telegram send failed", { error: errMsg(e) });
  }
}
