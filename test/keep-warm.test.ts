import { describe, expect, it } from "vitest";
import { KEEP_WARM_INTERVAL_MS, KEEP_WARM_WINDOW_MS, nextKeepWarmAt } from "../src/keep-warm";

describe("nextKeepWarmAt", () => {
  it("pings again inside Cloudflare's 10 s hibernation window while a session is active", () => {
    expect(KEEP_WARM_INTERVAL_MS).toBeLessThan(10_000);
    expect(nextKeepWarmAt(1_000_000, 1_000_000 - 60_000)).toBe(1_000_000 + KEEP_WARM_INTERVAL_MS);
  });
  it("stops once there has been no real call for the whole window", () => {
    expect(KEEP_WARM_WINDOW_MS).toBe(10 * 60_000);
    expect(nextKeepWarmAt(1_000_000, 1_000_000 - KEEP_WARM_WINDOW_MS)).toBeNull();
    expect(nextKeepWarmAt(1_000_000, undefined)).toBeNull();
  });
});
