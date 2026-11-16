/**
 * Keep the VaultEngine in memory during a session. Cloudflare hibernates an idle
 * Durable Object after 10 s (measured 2026-10-09: warm at 10 s idle, cold at 20 s),
 * which throws away the loaded vault and costs a ~5 s reload. After each real tool
 * call, an alarm fires every 8 s until there has been no real call for 10 minutes.
 * Alarms are cheap (one request + one row write each) and stop when nobody is using it.
 */
export const KEEP_WARM_INTERVAL_MS = 8_000;
export const KEEP_WARM_WINDOW_MS = 10 * 60_000;

/** When to fire the next keep-warm alarm, or null to let the object hibernate. */
export function nextKeepWarmAt(now: number, lastRealCallAt: number | undefined): number | null {
  if (lastRealCallAt === undefined || now - lastRealCallAt >= KEEP_WARM_WINDOW_MS) return null;
  return now + KEEP_WARM_INTERVAL_MS;
}
