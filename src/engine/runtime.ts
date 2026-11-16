import { Volume, createFsFromVolume } from "memfs";
import "./wasm_exec.js";
import engineWasm from "./okf-engine.wasm";

export type HubFetch = (method: string, path: string, body: Uint8Array | null) => Promise<{ status: number; body: Uint8Array }>;

declare global {
  // eslint-disable-next-line no-var
  var okfHubFetch: HubFetch | undefined;
  // eslint-disable-next-line no-var
  var okfEngineInit: (vaultId: string, keyHex: string) => Promise<string>;
  // eslint-disable-next-line no-var
  var okfEnginePull: () => Promise<string>;
  // eslint-disable-next-line no-var
  var okfEngineSync: (message: string) => Promise<string>;
  // eslint-disable-next-line no-var
  var okfEngineHandle: (requestLine: string) => Promise<string>;
}

export const BUNDLE_DIR = "/vault/knowledge";
const volume = new Volume();
let started: Promise<void> | undefined;
let exited = false;

/** True once the Go runtime has exited; every later export call would fail. */
export function engineExited(): boolean {
  return exited;
}

type FsLike = Record<string, unknown> & {
  writeSync(fd: number, buf: Uint8Array, ...rest: unknown[]): number;
  write(fd: number, buf: Uint8Array, offset: number, length: number, position: number | null, cb: (err: Error | null, n?: number) => void): void;
};

/**
 * memfs has no file descriptors 1 and 2, but Go writes its stdout/stderr
 * (logs, panics) there. Send those to the console; everything else to memfs.
 */
function withConsoleStdio(fs: FsLike): FsLike {
  const decoder = new TextDecoder();
  const pending: Record<number, string> = { 1: "", 2: "" };
  const emit = (fd: number, bytes: Uint8Array) => {
    pending[fd] += decoder.decode(bytes);
    const lines = pending[fd].split("\n");
    pending[fd] = lines.pop() ?? "";
    for (const line of lines) (fd === 2 ? console.error : console.log)(`[okf-engine] ${line}`);
  };
  return new Proxy(fs, {
    get(target, prop) {
      if (prop === "writeSync") {
        return (fd: number, buf: Uint8Array, ...rest: unknown[]) => {
          if (fd === 1 || fd === 2) {
            emit(fd, buf);
            return buf.length;
          }
          return target.writeSync(fd, buf, ...rest);
        };
      }
      if (prop === "write") {
        return (fd: number, buf: Uint8Array, offset: number, length: number, position: number | null, cb: (err: Error | null, n?: number) => void) => {
          if (fd === 1 || fd === 2) {
            emit(fd, buf.subarray(offset, offset + length));
            cb(null, length);
            return;
          }
          target.write(fd, buf, offset, length, position, cb);
        };
      }
      const value = target[prop as string];
      return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  }) as FsLike;
}

/**
 * Start the Go runtime once per isolate. Go's syscall/js captures
 * globalThis.fs at startup, so the memfs object is installed first and never
 * replaced; resets clear the volume instead.
 */
export function startEngine(): Promise<void> {
  if (!started) {
    started = (async () => {
      (globalThis as Record<string, unknown>).fs = withConsoleStdio(createFsFromVolume(volume) as unknown as FsLike);
      const go = new (globalThis as unknown as { Go: new () => { importObject: WebAssembly.Imports; run(i: WebAssembly.Instance): Promise<void> } }).Go();
      const instance = await WebAssembly.instantiate(engineWasm, go.importObject);
      // go.run resolves only if the Go runtime exits (a fatal error recover()
      // can't catch). Flag it so the Durable Object can restart cleanly.
      go.run(instance).then(() => { exited = true; }, () => { exited = true; });
    })();
  }
  return started;
}

/** Empty the in-memory filesystem and recreate the bundle directory. */
export function resetVolume(): void {
  volume.reset();
  volume.mkdirSync(BUNDLE_DIR, { recursive: true });
}
