import { isDeepStrictEqual } from "node:util";
import { type Client } from "@modelcontextprotocol/client";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/client/validators/ajv";

type WireClient = Pick<Client, "listTools" | "callTool">;
type ToolRequest = Parameters<WireClient["callTool"]>[0];
type OutputValidator = ReturnType<AjvJsonSchemaValidator["getValidator"]>;

const validators = new AjvJsonSchemaValidator();
const catalogs = new WeakMap<WireClient, Promise<Map<string, OutputValidator>>>();

function toolCatalog(client: WireClient): Promise<Map<string, OutputValidator>> {
  let catalog = catalogs.get(client);
  if (!catalog) {
    // This server advertises a fixed, unpaginated tool catalog.
    catalog = client.listTools().then(({ tools, nextCursor }) => {
      if (nextCursor) throw new Error("expected the fixed tool catalog in one page");
      return new Map(tools.map(({ name, outputSchema }) => {
        if (!outputSchema) throw new Error(`${name}: missing advertised output schema`);
        return [name, validators.getValidator(outputSchema)];
      }));
    });
    catalogs.set(client, catalog);
  }
  return catalog;
}

// Do not rely on the MCP SDK's implicit successful-response validation: it is
// cache-dependent, and the SDK intentionally skips output schemas for isError.
export async function callToolWithContract(client: WireClient, request: ToolRequest) {
  const validator = (await toolCatalog(client)).get(request.name);
  if (!validator) throw new Error(`${request.name}: tool was not advertised`);
  const result = await client.callTool(request);
  const output = result.structuredContent;
  const validation = validator(output);
  if (!validation.valid) {
    throw new Error(`${request.name}: invalid advertised output schema response: ${validation.errorMessage}`);
  }

  // The advertised schema is a union of both envelopes. A schema-valid error
  // still isn't a valid success, nor is a schema-valid success a valid error.
  const has = (key: string) => output !== null && typeof output === "object" && Object.hasOwn(output, key);
  if (result.isError === true ? !has("error") || has("data") : !has("data") || has("error")) {
    throw new Error(`${request.name}: isError does not match the structured response envelope`);
  }
  // Check the separate fallback consumed by clients that hide structuredContent.
  const first = result.content[0];
  if (first?.type !== "text") throw new Error(`${request.name}: missing text fallback`);
  if (result.isError === true) {
    const reason = (output as { error: { reason: string } }).error.reason;
    if (typeof reason !== "string" || !first.text.startsWith(`${request.name}: error ${reason}: `)) {
      throw new Error(`${request.name}: error text fallback disagrees with the structured reason`);
    }
  } else {
    let decoded: unknown;
    try { decoded = JSON.parse(first.text); } catch { throw new Error(`${request.name}: success fallback is not JSON`); }
    if (!isDeepStrictEqual(decoded, output)) throw new Error(`${request.name}: success fallback differs from the structured response`);
  }
  return result;
}
