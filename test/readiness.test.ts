import { afterEach, describe, expect, it, vi } from "vitest";
import { backoffMs, initUntilReady, Readiness, redact } from "../src/readiness.js";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const logged = (spy: { mock: { calls: unknown[][] } }) => spy.mock.calls.map((args) => JSON.parse(String(args[0])));

describe("initUntilReady", () => {
  it("retries a failing init with backoff until it succeeds, then marks ready", async () => {
    vi.useFakeTimers();
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const infos = vi.spyOn(console, "log").mockImplementation(() => {});
    const readiness = new Readiness();
    let attempts = 0;
    const init = vi.fn(async () => {
      attempts++;
      if (attempts < 3) throw new Error('password authentication failed for user "okf_hub"');
    });

    const done = initUntilReady({ init, readiness });
    await vi.advanceTimersByTimeAsync(0);
    expect(init).toHaveBeenCalledTimes(1);
    expect(readiness.ready).toBe(false);

    await vi.advanceTimersByTimeAsync(999); // the first wait is 1 s
    expect(init).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(init).toHaveBeenCalledTimes(2);
    expect(readiness.ready).toBe(false);

    await vi.advanceTimersByTimeAsync(1_999); // then 2 s
    expect(init).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(init).toHaveBeenCalledTimes(3);

    await expect(done).resolves.toBe(true);
    expect(readiness.ready).toBe(true);
    expect(logged(errors)).toEqual([
      { okfHub: "init_retry", attempt: 1, error: 'Error: password authentication failed for user "okf_hub"' },
      { okfHub: "init_retry", attempt: 2, error: 'Error: password authentication failed for user "okf_hub"' },
    ]);
    expect(logged(infos)).toEqual([{ okfHub: "ready", attempt: 3 }]);
  });

  it("stops when aborted, without marking ready or exiting", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const exit = vi.spyOn(process, "exit").mockImplementation((() => {}) as never);
    const readiness = new Readiness();
    const init = vi.fn(async () => { throw new Error("ECONNREFUSED"); });
    const stop = new AbortController();

    const done = initUntilReady({ init, readiness, signal: stop.signal });
    await vi.advanceTimersByTimeAsync(10_000);
    const before = init.mock.calls.length;
    expect(before).toBeGreaterThan(1);
    stop.abort();
    await expect(done).resolves.toBe(false);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(init).toHaveBeenCalledTimes(before);
    expect(readiness.ready).toBe(false);
    expect(exit).not.toHaveBeenCalled();
  });

  it("never logs credentials from an error", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    let first = true;
    const init = async () => {
      if (!first) return;
      first = false;
      throw new Error("connect failed: postgres://okf_hub:s3cret-pw@db.example:5432/okf?sslmode=verify-full; AccountKey=QUJDRA==;");
    };
    await initUntilReady({ init, readiness: new Readiness(), firstDelayMs: 1 });
    const line = String(errors.mock.calls[0][0]);
    expect(line).not.toContain("s3cret-pw");
    expect(line).not.toContain("QUJDRA==");
  });
});

describe("backoffMs", () => {
  it("doubles from 1 s and caps at 30 s", () => {
    expect([1, 2, 3, 4, 5, 6, 7, 100].map((n) => backoffMs(n))).toEqual([1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000, 30_000]);
  });
});

describe("redact", () => {
  it("masks URL passwords, keys, signatures and passwords, and leaves the rest", () => {
    expect(redact("postgres://okf_hub:p@ss/w0rd@db:5432/x")).toBe("postgres://okf_hub:***@db:5432/x");
    expect(redact("AccountName=a;AccountKey=abc+/==;BlobEndpoint=http://b")).toBe("AccountName=a;AccountKey=***;BlobEndpoint=http://b");
    expect(redact("https://a.blob.core.windows.net/c?sv=1&sig=xyz%2F&se=2")).toBe("https://a.blob.core.windows.net/c?sv=1&sig=***&se=2");
    expect(redact("host=db password=hunter2 user=x")).toBe("host=db password=*** user=x");
    expect(redact("connect ECONNREFUSED 10.0.0.4:5432")).toBe("connect ECONNREFUSED 10.0.0.4:5432");
  });
});
