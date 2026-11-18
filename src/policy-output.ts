import type { ToolResult } from "./engine-host.js";
import { SEARCH_MAX, isExcluded, linkTarget, stripExcludedLinks, type Policy } from "./policy";

type SearchHit = { concept_id: string; inbound?: string[]; outbound?: string[] } & Record<string, unknown>;
type Concept = { id: string; body?: string; raw_content?: string } & Record<string, unknown>;
type BrokenLink = { source_concept: string; target_href: string; reason: string };
type Report = { errors?: string[]; warnings?: string[]; gate_findings?: string[]; broken_links?: BrokenLink[]; orphans?: string[] } & Record<string, unknown>;

/** The result count the caller asked okf_search for, with okf's own default and cap. */
export function requestedLimit(args: Record<string, unknown>): number {
  const limit = args.limit;
  if (typeof limit !== "number" || !(limit >= 1)) return 10;
  return Math.min(Math.floor(limit), SEARCH_MAX);
}

const reply = (text: unknown, structured: unknown): ToolResult => ({
  content: [{ type: "text", text: JSON.stringify(text) }],
  structuredContent: structured,
});

function mentionsHidden(text: string, exclude: readonly string[]): boolean {
  const lower = text.toLowerCase();
  return exclude.some((prefix) => lower.includes(prefix.toLowerCase()));
}

function filterSearch(args: Record<string, unknown>, data: { results?: SearchHit[] }, policy: Policy): ToolResult {
  const keep = (id: string) => !isExcluded(id, policy.exclude);
  const results = (data.results ?? [])
    .filter((hit) => keep(hit.concept_id))
    .slice(0, requestedLimit(args))
    .map((hit) => ({
      ...hit,
      ...(hit.inbound ? { inbound: hit.inbound.filter(keep) } : {}),
      ...(hit.outbound ? { outbound: hit.outbound.filter(keep) } : {}),
    }));
  return reply(results, { results });
}

function filterConcept(concept: Concept, policy: Policy): ToolResult {
  if (isExcluded(concept.id, policy.exclude)) {
    return { isError: true, content: [{ type: "text", text: `Refused by access policy: "${concept.id}" is in a folder this app may not access.` }] };
  }
  const out: Concept = { ...concept };
  if (typeof out.body === "string") out.body = stripExcludedLinks(concept.id, out.body, policy.exclude);
  if (typeof out.raw_content === "string") out.raw_content = stripExcludedLinks(concept.id, out.raw_content, policy.exclude);
  return reply(out, out);
}

function filterReport(report: Report, policy: Policy): ToolResult {
  const strings = (list?: string[]) => list?.filter((item) => !mentionsHidden(item, policy.exclude));
  const out: Report = { ...report };
  for (const key of ["errors", "warnings", "gate_findings"] as const) {
    if (report[key]) out[key] = strings(report[key]);
  }
  if (report.broken_links) {
    out.broken_links = report.broken_links.filter((link) => {
      const target = linkTarget(link.source_concept, link.target_href);
      return !isExcluded(link.source_concept, policy.exclude) && !(target !== null && isExcluded(target, policy.exclude));
    });
  }
  if (report.orphans) out.orphans = report.orphans.filter((id) => !isExcluded(id, policy.exclude));
  return reply(out, out);
}

/** Apply a grant's hidden folders to what okf returned. Errors and unrestricted grants pass through. */
export function filterResult(tool: string, args: Record<string, unknown>, result: ToolResult, policy: Policy): ToolResult {
  if (result.isError || !policy.exclude.length) return result;
  const data = result.structuredContent as Record<string, unknown> | undefined;
  if (!data || typeof data !== "object") return result;
  if (tool === "okf_search") return filterSearch(args, data as { results?: SearchHit[] }, policy);
  if (tool === "okf_validate") return filterReport(data as Report, policy);
  if (typeof data.id === "string" && "body" in data) return filterConcept(data as Concept, policy);
  return result;
}
