import { readFile } from "node:fs/promises";
import { Volume, createFsFromVolume } from "memfs";
import "./wasm_exec.js";
import { serialQueue } from "../serial.js";

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
  // Node has WebAssembly built in, but lib "es2024" carries no types for it: declare what this module uses.
  namespace WebAssembly {
    type Imports = Record<string, Record<string, unknown>>;
    interface Module {}
    interface Instance {}
    function compile(bytes: Uint8Array): Promise<Module>;
    function instantiate(module: Module, imports: Imports): Promise<Instance>;
  }
}

export const BUNDLE_DIR = "/vault/knowledge";
const volume = new Volume();
let started: Promise<void> | undefined;
let exited = false;

/**
 * The Go runtime, its filesystem and its one open vault are per process, and every vault shares
 * them. So the lock and the record of which vault is loaded live here: every use of the engine runs
 * under `engineExclusive`, and a vault that is not the loaded one is reloaded from scratch before it
 * is touched.
 */
export const engineExclusive = serialQueue();
let loadedVault = "";
export function loadedVaultId(): string {
  return loadedVault;
}
export function setLoadedVault(vaultId: string): void {
  loadedVault = vaultId;
}

let exitedOverride: (() => boolean) | null = null;

/** True once the Go runtime has exited; every later export call would fail. */
export function engineExited(): boolean {
  return exitedOverride ? exitedOverride() : exited;
}

/** Test-only: make `engineExited` answer from `fn` instead of the real runtime; `null` restores it. */
export function __setEngineExitedForTest(fn: (() => boolean) | null): void {
  exitedOverride = fn;
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
 * Start the Go runtime once per process. Go's syscall/js captures
 * globalThis.fs at startup, so the memfs object is installed first and never
 * replaced; resets clear the volume instead.
 */
export function startEngine(): Promise<void> {
  if (!started) {
    started = (async () => {
      (globalThis as Record<string, unknown>).fs = withConsoleStdio(createFsFromVolume(volume) as unknown as FsLike);
      const go = new (globalThis as unknown as { Go: new () => { importObject: WebAssembly.Imports; run(i: WebAssembly.Instance): Promise<void> } }).Go();
      // The Wasm sits next to this module: src/engine/ under vitest, dist/engine/ once built.
      const engineWasm = await WebAssembly.compile(await readFile(new URL("./okf-engine.wasm", import.meta.url)));
      const instance = await WebAssembly.instantiate(engineWasm, go.importObject);
      // go.run resolves only if the Go runtime exits (a fatal error recover()
      // can't catch). Flag it so the host can restart cleanly.
      go.run(instance).then(() => { exited = true; }, () => { exited = true; });
    })();
  }
  return started;
}

/** Empty the in-memory filesystem and recreate the bundle directory. */
export function resetVolume(): void {
  loadedVault = "";
  volume.reset();
  volume.mkdirSync(BUNDLE_DIR, { recursive: true });
}

/** Every file of the loaded bundle as text, by path relative to the bundle root. Skips dot folders (sync state). */
export function readBundleFiles(): Record<string, string> {
  const files: Record<string, string> = {};
  const walk = (dir: string, rel: string) => {
    for (const name of volume.readdirSync(dir) as string[]) {
      if (name.startsWith(".")) continue;
      const path = `${dir}/${name}`;
      const relPath = rel ? `${rel}/${name}` : name;
      if (volume.statSync(path).isDirectory()) walk(path, relPath);
      else files[relPath] = volume.readFileSync(path, "utf8") as string;
    }
  };
  if (volume.existsSync(BUNDLE_DIR)) walk(BUNDLE_DIR, "");
  return files;
}
