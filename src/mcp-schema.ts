import { z, type ZodTypeAny } from "zod";

type JsonProp = { type?: string; description?: string; enum?: string[]; items?: { type?: string } };
type JsonSchema = { properties?: Record<string, JsonProp>; required?: string[] };

/** Arguments that only make sense against a local filesystem. */
const REMOTE_EXCLUDED_ARGS = new Set(["bundle"]);

function propToZod(prop: JsonProp): ZodTypeAny {
  let schema: ZodTypeAny;
  switch (prop.type) {
    case "string":
      schema = prop.enum?.length ? z.enum(prop.enum as [string, ...string[]]) : z.string();
      break;
    case "integer":
      schema = z.number().int();
      break;
    case "number":
      schema = z.number();
      break;
    case "boolean":
      schema = z.boolean();
      break;
    case "array":
      schema = z.array(prop.items?.type === "string" ? z.string() : z.unknown());
      break;
    default:
      schema = z.unknown();
  }
  return prop.description ? schema.describe(prop.description) : schema;
}

/** Convert one okf tool's JSON Schema into the zod shape the MCP SDK registers. */
export function toolInputShape(schema: JsonSchema): Record<string, ZodTypeAny> {
  const required = new Set(schema.required ?? []);
  const shape: Record<string, ZodTypeAny> = {};
  for (const [name, prop] of Object.entries(schema.properties ?? {})) {
    if (REMOTE_EXCLUDED_ARGS.has(name)) continue;
    shape[name] = required.has(name) ? propToZod(prop) : propToZod(prop).optional();
  }
  return shape;
}
