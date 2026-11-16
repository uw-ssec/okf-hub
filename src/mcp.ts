import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { z } from "zod";
import okfTools from "./okf-tools.json";
import { toolInputShape } from "./mcp-schema";
import { presentTool } from "./tool-presentation";
import { rpcSummary } from "./rpc-summary";
import { guardedCall, type Engine } from "./guarded-call";
import { PolicyError, policyFromProps, toolAllowed, type Policy } from "./policy";

type OkfTool = { name: string; description: string; inputSchema: Parameters<typeof toolInputShape>[0] };

/** The bundle's ground rules, carried to every remote client. */
export const SERVER_INSTRUCTIONS = [
  "This is a shared OKF knowledge bundle (OKF v0.2).",
  "Search before creating: run okf_search first and prefer okf_update over a duplicate okf_create.",
  "Never write secret values (passwords, tokens, API keys, recovery codes) into a concept; name the secret and where it is stored instead.",
  "Some apps are approved read-only or with hidden folders. A refusal names the access policy; do not try to work around it.",
].join("\n");

/** One server per request (stateless); tools are limited to the grant's access and every call is guarded. */
function createServer(env: Env, policy: Policy): McpServer {
  const server = new McpServer({ name: "okf-hub", version: "1.1.0" }, { instructions: SERVER_INSTRUCTIONS });
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
  if (request.method === "POST") {
    // Which calls each app makes (method and tool name only), for diagnosing clients.
    console.log(JSON.stringify({ mcp: rpcSummary(await request.clone().text()), app: policy.clientName, access: policy.access }));
  }
  return createMcpHandler(() => createServer(env, policy), { route: "/mcp", responseMode: "json" })(request, env, ctx);
}
