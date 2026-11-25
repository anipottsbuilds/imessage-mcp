import { expect, it, vi } from "vitest";
import { callToolWithContract } from "./wire-tool-contract.js";

const name = "synthetic_tool";
const success = { content: [{ type: "text", text: '{"data":{"count":2}}' }], structuredContent: { data: { count: 2 } } };
const error = { content: [{ type: "text", text: "synthetic_tool: error INVALID_INPUT: invalid value" }], isError: true, structuredContent: { error: { reason: "INVALID_INPUT", message: "invalid value" } } };
const outputSchema = {
  type: "object",
  anyOf: [
    { required: ["data"], properties: { data: {
      type: "object", required: ["count"], properties: { count: { type: "integer" } },
    } } },
    { required: ["error"], properties: { error: {
      type: "object", required: ["reason"], properties: { reason: { type: "string" } },
    } } },
  ],
} as const;

function syntheticClient(reply: unknown) {
  return {
    listTools: vi.fn(async () => ({ tools: [{ name, inputSchema: { type: "object" }, outputSchema }] })),
    // A deliberately non-validating fake: the contract helper must catch what a
    // cached or future SDK validator would not. No real server/data is involved.
    callTool: vi.fn(async () => reply),
  } as unknown as Parameters<typeof callToolWithContract>[0];
}

it.each([success, error])("accepts a valid schema and matching success/error envelope", async (reply) => {
  const client = syntheticClient(reply);
  await expect(callToolWithContract(client, { name })).resolves.toEqual(reply);
  await expect(callToolWithContract(client, { name })).resolves.toEqual(reply);
  expect(client.listTools).toHaveBeenCalledTimes(1);
});

it.each([
  { content: [], structuredContent: { data: { count: "not an integer" } } },
  { content: [], isError: true, structuredContent: { error: { reason: 42 } } },
  { content: [] },
])("rejects a deliberately invalid or missing structured result", async (reply) => {
  await expect(callToolWithContract(syntheticClient(reply), { name })).rejects.toThrow("invalid advertised output schema response");
});

it.each([
  { ...success, isError: true },
  { ...error, isError: false },
])("rejects a schema-valid result with a contradictory isError flag", async (reply) => {
  await expect(callToolWithContract(syntheticClient(reply), { name })).rejects.toThrow("isError does not match");
});

it("rejects a different JSON text fallback even when the structured result is valid", async () => {
  const reply = { ...success, content: [{ type: "text", text: '{"data":{"count":3}}' }] };
  await expect(callToolWithContract(syntheticClient(reply), { name })).rejects.toThrow("success fallback differs");
});

it.each(["synthetic_tool: error NOT_FOUND: no match", "synthetic_tool: error INVALID_INPUT: wrong message"])("rejects an error fallback with the wrong reason or message", async (text) => {
  const reply = { ...error, content: [{ type: "text", text }] };
  await expect(callToolWithContract(syntheticClient(reply), { name })).rejects.toThrow("error text fallback disagrees");
});
