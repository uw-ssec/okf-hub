import type { ToolResult } from "./engine-host.js";
import { checkInput, engineArgs, type Policy } from "./policy.js";
import { filterResult } from "./policy-output.js";

/** The slice of the VaultEngine Durable Object a tool call needs. */
export type Engine = { callTool(name: string, args: Record<string, unknown>, actor: string): Promise<ToolResult> };

/** One tool call under a grant's policy: refuse before okf runs, filter what comes back. */
export async function guardedCall(engine: Engine, tool: string, args: Record<string, unknown>, policy: Policy): Promise<ToolResult> {
  const refusal = checkInput(tool, args, policy);
  if (refusal) return { isError: true, content: [{ type: "text", text: refusal }] };
  // The actor becomes the commit message prefix: "<client name>: <tool>".
  const result = await engine.callTool(tool, engineArgs(tool, args, policy), policy.clientName);
  return filterResult(tool, args, result, policy);
}
