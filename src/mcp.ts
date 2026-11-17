import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { z } from "zod";
import okfTools from "./okf-tools.json";
import { toolInputShape } from "./mcp-schema";
import { presentTool } from "./tool-presentation";
import { rpcSummary } from "./rpc-summary";
import { guardedCall, type Engine } from "./guarded-call";
import { PolicyError, policyFromProps, READ_TOOLS, toolAllowed, type Policy } from "./policy";
import { accessFor, defaultBundle, isBundleName, vaultIdFor } from "./bundles";
import type { ToolResult } from "./vault-engine";

/** The engine's bundle directory (src/engine/runtime.ts); not imported, since that module loads the Wasm. */
const BUNDLE_DIR = "/vault/knowledge";

type OkfTool = { name: string; description: string; inputSchema: Parameters<typeof toolInputShape>[0] };

/** The bundle's ground rules, carried to every remote client. */
export const SERVER_INSTRUCTIONS = [
  "This is a shared OKF knowledge bundle (OKF v0.2).",
  "Search before creating: run okf_search first and prefer okf_update over a duplicate okf_create.",
  "Never write secret values (passwords, tokens, API keys, recovery codes) into a concept; name the secret and where it is stored instead.",
  "Some apps are approved read-only or with hidden folders. A refusal names the access policy; do not try to work around it.",
].join("\n");

const BUNDLE_ARG = z
  .string()
  .optional()
  .describe("Name of the knowledge bundle to use. Leave it out to use this connection's own bundle.");

const denied = (text: string): ToolResult => ({ isError: true, content: [{ type: "text", text: `Access denied: ${text}` }] });

type EngineStub = { callTool(name: string, args: Record<string, unknown>, actor: string, vaultId: string): Promise<ToolResult> };

/**
 * One tool call for an OIDC caller: the bundle comes from the call's `bundle` argument, else the
 * request's `?bundle=`, else the token's only bundle; the token's grant for it decides the access.
 */
export async function bundleCall(
  env: Env,
  tool: string,
  args: Record<string, unknown>,
  policy: Policy,
  requestBundle: string | null,
): Promise<ToolResult> {
  const grants = policy.bundles ?? [];
  const { bundle: argBundle, ...rest } = args;
  const bundle = argBundle ?? requestBundle ?? defaultBundle(grants);
  if (typeof bundle !== "string" || !bundle) return denied("name the bundle to use; this connection has no default bundle.");
  const access = isBundleName(bundle) ? accessFor(grants, bundle) : null;
  if (!access) return denied(`this connection may not use the bundle "${bundle}".`);
  if (access === "read" && !READ_TOOLS.has(tool)) return denied(`${tool} changes the bundle "${bundle}", and this connection may only read it.`);
  const vaultId = await vaultIdFor(bundle);
  const stub = env.VAULT_ENGINE.getByName(vaultId) as unknown as EngineStub;
  const engine: Engine = { callTool: (name, a, actor) => stub.callTool(name, a, actor, vaultId) };
  const result = await guardedCall(engine, tool, rest, { ...policy, access: access === "write" ? "full" : "read" });
  return nameBundle(result, bundle);
}

/** okf reports where it wrote as its internal directory; a remote caller should see the bundle's name. */
export function nameBundle(result: ToolResult, bundle: string): ToolResult {
  const swap = (text: string) => text.split(BUNDLE_DIR).join(bundle);
  const structured = result.structuredContent;
  return {
    ...result,
    content: result.content.map((c) => (c.type === "text" ? { ...c, text: swap(c.text) } : c)),
    ...(structured !== undefined ? { structuredContent: JSON.parse(swap(JSON.stringify(structured))) } : {}),
  };
}

/** One server per request (stateless); tools are limited to the grant's access and every call is guarded. */
function createServer(env: Env, policy: Policy, requestBundle: string | null): McpServer {
  const server = new McpServer({ name: "okf-hub", version: "1.2.0" }, { instructions: SERVER_INSTRUCTIONS });
  if (policy.bundles) {
    // Access depends on the bundle each call names, so every tool is listed and each call is checked.
    for (const tool of okfTools as unknown as OkfTool[]) {
      server.registerTool(
        tool.name,
        { ...presentTool(tool.name, tool.description), inputSchema: z.object({ ...toolInputShape(tool.inputSchema), bundle: BUNDLE_ARG }) },
        async (args: Record<string, unknown>) => bundleCall(env, tool.name, args, policy, requestBundle),
      );
    }
    return server;
  }
  const engine = env.VAULT_ENGINE.getByName(env.MCP_VAULT_ID) as unknown as Engine;
  for (const tool of okfTools as unknown as OkfTool[]) {
    if (!toolAllowed(tool.name, policy.access)) continue;
    server.registerTool(
      tool.name,
      { ...presentTool(tool.name, tool.description), inputSchema: z.object(toolInputShape(tool.inputSchema)) },
      async (args: Record<string, unknown>) => guardedCall(engine, tool.name, args, policy),
    );
  }
  return server;
}

/** OAuthProvider has already authenticated the request; ctx.props is the grant's policy. */
export async function handleMcp(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  let policy: Policy;
  try {
    policy = policyFromProps((ctx as { props?: unknown }).props);
  } catch (err) {
    if (!(err instanceof PolicyError)) throw err;
    return Response.json({ error: "forbidden", error_description: `This grant's access policy is invalid: ${err.message}` }, { status: 403 });
  }
  const requestBundle = new URL(request.url).searchParams.get("bundle");
  if (requestBundle !== null) {
    if (!policy.bundles) {
      return Response.json({ error: "invalid_request", error_description: "This connection serves one vault and takes no bundle." }, { status: 400 });
    }
    if (!accessFor(policy.bundles, requestBundle)) {
      return Response.json({ error: "forbidden", error_description: `This token may not use the bundle "${requestBundle}".` }, { status: 403 });
    }
  }
  if (request.method === "POST") {
    // Which calls each app makes (method and tool name only), for diagnosing clients.
    console.log(JSON.stringify({ mcp: rpcSummary(await request.clone().text()), app: policy.clientName, access: policy.access, bundle: requestBundle ?? undefined }));
  }
  return createMcpHandler(() => createServer(env, policy, requestBundle), { route: "/mcp", responseMode: "json" })(request, env, ctx);
}
