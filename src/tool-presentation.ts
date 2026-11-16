/**
 * How the okf tools present themselves to remote clients. okf's own descriptions say
 * "the OKF knowledge bundle", which tells a client like ChatGPT nothing about what
 * this memory holds or when to reach for it, and ChatGPT treats tools without a read-only
 * hint as risky actions. Prefix the descriptions and add MCP tool annotations.
 */
const MEMORY = "OKF knowledge bundle: shared, persistent memory for this deployment.";

const PRESENTATION: Record<string, { title: string; lead: string; readOnly: boolean }> = {
  okf_search: {
    title: "Search the knowledge bundle",
    lead: `${MEMORY} Call this before answering whenever the user mentions a person, project, tool, concept, or acronym you don't recognize or that sounds specific to their organization, then open the best hits with okf_show.`,
    readOnly: true,
  },
  okf_show: { title: "Read a concept", lead: `${MEMORY} Read one concept found with okf_search.`, readOnly: true },
  okf_validate: { title: "Check the knowledge bundle", lead: `${MEMORY} Check the bundle for broken links and problems.`, readOnly: true },
  okf_create: { title: "Add a concept", lead: `${MEMORY} Search first; create only when no existing concept fits. Never store secret values.`, readOnly: false },
  okf_update: { title: "Update a concept", lead: `${MEMORY} Prefer updating an existing concept over creating a duplicate. Never store secret values.`, readOnly: false },
  okf_relate: { title: "Link concepts", lead: `${MEMORY} Link two existing concepts.`, readOnly: false },
};

export type ToolAnnotations = { title: string; readOnlyHint: boolean; destructiveHint?: boolean; openWorldHint: boolean };

export function presentTool(name: string, okfDescription: string): { title?: string; description: string; annotations?: ToolAnnotations } {
  const p = PRESENTATION[name];
  if (!p) return { description: okfDescription };
  const annotations: ToolAnnotations = p.readOnly
    ? { title: p.title, readOnlyHint: true, openWorldHint: false }
    : { title: p.title, readOnlyHint: false, destructiveHint: false, openWorldHint: false };
  return { title: p.title, description: `${p.lead}\n\n${okfDescription}`, annotations };
}
