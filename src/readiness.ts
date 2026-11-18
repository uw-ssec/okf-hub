/**
 * Starting without waiting for the backing services. On a first deploy the hub's database role can
 * be created only after the hub itself is up, so the hub listens at once and prepares its stores in
 * the background, retrying until they answer. Until then /healthz says `starting` and every other
 * route answers 503 (src/app.ts), so no engine call runs before the stores are ready.
 */

/** Whether the stores have been prepared once. It never goes back: later outages are /healthz's to report. */
export class Readiness {
  private isReady = false;

  get ready(): boolean {
    return this.isReady;
  }

  markReady(): void {
    this.isReady = true;
  }
}

export const INIT_FIRST_DELAY_MS = 1_000;
export const INIT_MAX_DELAY_MS = 30_000;

/** The wait after failed attempt `attempt` (1-based): doubling from the first delay, capped. */
export function backoffMs(attempt: number, firstMs = INIT_FIRST_DELAY_MS, maxMs = INIT_MAX_DELAY_MS): number {
  return Math.min(maxMs, firstMs * 2 ** Math.min(attempt - 1, 30));
}

/** An error's text with credentials masked: URL user info, and key, signature and password values. */
export function redact(text: string): string {
  return text
    .replace(/(\/\/[^/\s:@]*:)\S*@/g, "$1***@")
    .replace(/\b(AccountKey|SharedAccessSignature|sig|password)=[^;&\s]+/gi, "$1=***");
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });
}

export type InitLoopOptions = {
  /** Prepares the stores; throws while they are not usable. Must be safe to repeat. */
  init: () => Promise<void>;
  readiness: Readiness;
  /** Aborting stops the loop after the attempt in flight. */
  signal?: AbortSignal;
  firstDelayMs?: number;
  maxDelayMs?: number;
};

/**
 * Runs `init` until it succeeds, then marks `readiness`. Logs one JSON line per failed attempt and
 * one on success. Never throws and never exits the process. Resolves true once ready, false if stopped.
 */
export async function initUntilReady({ init, readiness, signal, firstDelayMs, maxDelayMs }: InitLoopOptions): Promise<boolean> {
  for (let attempt = 1; !signal?.aborted; attempt++) {
    try {
      await init();
      readiness.markReady();
      console.log(JSON.stringify({ okfHub: "ready", attempt }));
      return true;
    } catch (err) {
      console.error(JSON.stringify({ okfHub: "init_retry", attempt, error: redact(String(err)) }));
    }
    await sleep(backoffMs(attempt, firstDelayMs, maxDelayMs), signal);
  }
  return false;
}
