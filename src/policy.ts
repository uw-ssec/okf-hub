/**
 * Per-grant access policy for the remote MCP endpoint: which tools a client
 * may call and which folders it may never read, write, or see links into.
 * Pure functions only, so every rule is unit-tested.
 */
import { parseGrants, type BundleGrant } from "./bundles.js";

export type Access = "full" | "read";
/** `bundles` is set for OIDC callers only: then the request picks a bundle and its grant decides the access. */
export type Policy = { clientName: string; access: Access; exclude: string[]; bundles?: BundleGrant[] };
/** What a grant stores in its encrypted props (and the legacy token and OIDC tokens resolve to). */
export type GrantProps = { githubUserId?: number; clientId?: string; clientName: string; access: Access; exclude: string[]; bundles?: BundleGrant[] };

export const LEGACY_PROPS: GrantProps = { clientName: "legacy-token", access: "full", exclude: [] };
export const READ_TOOLS: ReadonlySet<string> = new Set(["okf_search", "okf_show", "okf_validate"]);
export const ID_ARGS = ["concept_id", "source_id", "target_id"] as const;
/** okf_search's own maximum; used to over-fetch when results will be filtered. */
export const SEARCH_MAX = 100;

export const SCOPES = { read: "okf:read", write: "okf:write", offline: "offline_access" } as const;
export function scopesFor(access: Access): string[] {
  return access === "full" ? [SCOPES.read, SCOPES.write, SCOPES.offline] : [SCOPES.read, SCOPES.offline];
}

export class PolicyError extends Error {}

export function toolAllowed(name: string, access: Access): boolean {
  return access === "full" || READ_TOOLS.has(name);
}

/** Canonical concept id for policy checks: no "./", no repeated "/", no ".md". Refuses ".." and absolute paths. */
export function normalizeConceptId(raw: string): string {
  // okf trims with Go's whitespace set, which includes U+0085 (JS trim doesn't), before it
  // resolves an id. Refusing control and format characters outright keeps the id we check
  // identical to the one okf resolves.
  if (/\p{C}/u.test(raw)) throw new PolicyError(`concept id "${raw}" contains control or format characters, which are not allowed`);
  const id = raw.trim().replace(/\\/g, "/");
  if (id.startsWith("/")) throw new PolicyError(`concept id "${raw}" is an absolute path, which is not allowed`);
  const parts = id.split("/").filter((part) => part !== "" && part !== ".");
  if (parts.includes("..")) throw new PolicyError(`concept id "${raw}" uses "..", which is not allowed`);
  return parts.join("/").replace(/\.md$/i, "");
}

/** A folder prefix in canonical form, always ending in "/". */
export function normalizePrefix(raw: string): string {
  const id = normalizeConceptId(raw.replace(/^\/+/, ""));
  if (!id) throw new PolicyError("an empty hidden folder is not allowed");
  return `${id}/`;
}

/** Hidden folders typed on the consent page: comma or whitespace separated. */
export function parseExcludes(text: string): string[] {
  const entries = text.split(/[\s,]+/).filter(Boolean).map(normalizePrefix);
  return [...new Set(entries)].sort();
}

/** True when the id is a hidden folder or anything under one. Case-insensitive, to err on the side of hiding. */
export function isExcluded(id: string, exclude: readonly string[]): boolean {
  const candidate = `${id.toLowerCase()}/`;
  return exclude.some((prefix) => candidate.startsWith(prefix.toLowerCase()));
}

/** Why this call is refused, or null when the policy allows it. */
export function checkInput(tool: string, args: Record<string, unknown>, policy: Policy): string | null {
  if (!toolAllowed(tool, policy.access)) {
    return `Refused by access policy: ${tool} changes the vault, and this app was approved for read only.`;
  }
  for (const key of ID_ARGS) {
    const value = args[key];
    if (typeof value !== "string") continue;
    let id: string;
    try {
      id = normalizeConceptId(value);
    } catch (err) {
      return `Refused by access policy: ${(err as Error).message}.`;
    }
    if (isExcluded(id, policy.exclude)) {
      return `Refused by access policy: "${id}" is in a folder this app may not access.`;
    }
  }
  return null;
}

/** Arguments for the engine: ids in canonical form; search over-fetches when results will be filtered. */
export function engineArgs(tool: string, args: Record<string, unknown>, policy: Policy): Record<string, unknown> {
  const out: Record<string, unknown> = { ...args };
  for (const key of ID_ARGS) {
    if (typeof out[key] === "string") out[key] = normalizeConceptId(out[key] as string);
  }
  if (tool === "okf_search" && policy.exclude.length) out.limit = SEARCH_MAX;
  return out;
}

/** The concept id a markdown link inside concept `fromId` points at, or null for external links. */
export function linkTarget(fromId: string, href: string): string | null {
  const path = href.replace(/\\/g, "/").split("#")[0].split("?")[0].trim(); // okf's ResolveLink treats "\\" as "/"
  if (!path || path.startsWith("//") || /^[a-z][a-z0-9+.-]*:/i.test(path)) return null;
  const parts = path.startsWith("/") ? [] : fromId.split("/").slice(0, -1);
  for (const segment of path.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (parts.length === 0) return null; // above the bundle root: not a concept
      parts.pop();
    } else {
      parts.push(segment);
    }
  }
  return parts.join("/").replace(/\.md$/i, "");
}

const INLINE_LINK = /\]\(\s*<?([^)\s>]+)>?(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\s*\)/g;
const REFERENCE_DEF = /^\s*\[([^\]]+)\]:\s*<?(\S+?)>?(?:\s+.*)?$/;
const REFERENCE_USE = /\[([^\]]+)\](?!\()/g;
const HTML_LINK = /\b(?:href|src)\s*=\s*["']([^"']+)["']/gi;

/**
 * Remove every line that links into a hidden folder (e.g. "Related Concepts" entries):
 * inline links, reference definitions and the lines that use their labels, and HTML href/src.
 */
export function stripExcludedLinks(fromId: string, text: string, exclude: readonly string[]): string {
  if (!exclude.length) return text;
  const linksHidden = (href: string) => {
    const target = linkTarget(fromId, href);
    return target !== null && isExcluded(target, exclude);
  };
  const lines = text.split("\n");
  const hiddenLabels = new Set<string>();
  for (const line of lines) {
    const def = REFERENCE_DEF.exec(line);
    if (def && linksHidden(def[2])) hiddenLabels.add(def[1].trim().toLowerCase());
  }
  return lines
    .filter((line) => {
      const def = REFERENCE_DEF.exec(line);
      if (def) return !hiddenLabels.has(def[1].trim().toLowerCase());
      if ([...line.matchAll(INLINE_LINK)].some((m) => linksHidden(m[1]))) return false;
      if ([...line.matchAll(HTML_LINK)].some((m) => linksHidden(m[1]))) return false;
      return ![...line.matchAll(REFERENCE_USE)].some((m) => hiddenLabels.has(m[1].trim().toLowerCase()));
    })
    .join("\n");
}

/** The policy a token carries. Missing access means read-only; a malformed exclusion list is an error. */
export function policyFromProps(props: unknown): Policy {
  const p = (props ?? {}) as Partial<GrantProps>;
  const policy: Policy = {
    clientName: sanitizeActor(p.clientName),
    access: p.access === "full" ? "full" : "read",
    exclude: Array.isArray(p.exclude) ? p.exclude.map((entry) => normalizePrefix(String(entry))) : [],
  };
  if (p.bundles !== undefined) {
    try {
      policy.bundles = parseGrants(p.bundles);
    } catch (err) {
      throw new PolicyError((err as Error).message);
    }
  }
  return policy;
}

/** A client name made safe for a one-line commit message. Client names are self-asserted. */
export function sanitizeActor(name: unknown): string {
  const clean = String(name ?? "")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 64);
  return clean || "unknown-client";
}
