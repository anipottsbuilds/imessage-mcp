import { describe, expect, it } from "vitest";
import { score, traceRecord } from "../scripts/host-goldens.mjs";

const read = (name: string) => ({ method: "resources/read", uri: `skill://${name}/SKILL.md` });
const call = (tool: string, args: Record<string, unknown> = {}) => ({ method: "tools/call", tool, ...args });
const pair = (message_id: number, chat_id: number) => ({ message_id, chat_id });

describe("real-host golden score contract", () => {
  const catchTrace = [read("catch-up"), call("list_conversations"), call("get_conversation", { chat_id: 11 })];
  const newerAsk = pair(102, 11);
  const laterAsk = pair(202, 22);
  it("checks urgency and removes an ask after cancellation without changing the other result", () => {
    const pending = { matches: [newerAsk, laterAsk] };
    expect(score("new-ask", pending, catchTrace).passed).toBe(true);
    expect(score("cancelled-ask", pending, catchTrace).passed).toBe(false);
    expect(score("cancelled-ask", { matches: [laterAsk] }, catchTrace).passed).toBe(true);
    expect(score("new-ask", { matches: [laterAsk, newerAsk] }, catchTrace).passed).toBe(false);
  });

  it("rejects the replied:false regression, a non-read-only call, and an unobserved skill read", () => {
    const answer = { matches: [newerAsk, laterAsk] };
    expect(score("new-ask", answer, [...catchTrace, call("list_conversations", { replied: false })]).passed).toBe(false);
    expect(score("new-ask", answer, [...catchTrace, call("send_message")]).passed).toBe(false);
    expect(score("new-ask", answer, catchTrace.slice(1)).passed).toBe(false);
  });

  it("requires the exact phrase and verified chat instead of picking a shared membership by order", () => {
    const answer = { matches: [pair(305, 22)] };
    const findTrace = [read("find-it"), call("search_messages", { mode: "exact" }),
      call("get_conversation", { chat_id: 22, around_message_id: 305 })];
    expect(score("specific-chat", answer, findTrace).passed).toBe(true);
    expect(score("specific-chat", { matches: [pair(305, 33)] }, findTrace).passed).toBe(false);
    expect(score("specific-chat", { matches: [pair(304, 11)] }, findTrace).passed).toBe(false);
    expect(score("specific-chat", answer, findTrace.slice(0, -1)).passed).toBe(false);
    expect(score("specific-chat", answer, [...findTrace,
      call("search_messages", { mode: "exact", has_person_filter: true })]).passed).toBe(false);
  });
});

describe("golden trace scope", () => {
  it("drops payload values and suppresses unknown tool and URI strings", () => {
    const marker = "fictional private trace marker";
    expect(traceRecord({ method: "tools/call", params: { name: marker, arguments: {
      mode: marker, replied: marker, chat_id: marker, around_message_id: -2, contact: marker, query: marker,
    } } })).toEqual({ method: "tools/call", tool: "unexpected", has_person_filter: true });
    expect(traceRecord({ method: "resources/read", params: { uri: marker } }))
      .toEqual({ method: "resources/read" });
    expect(traceRecord({ method: "tools/call", params: { name: "get_conversation", arguments: {
      chat_id: 22, around_message_id: 305, query: marker,
    } } })).toEqual({ method: "tools/call", tool: "get_conversation", chat_id: 22, around_message_id: 305 });
  });

  it("never passes a truncated synthetic trace", () => {
    expect(score("new-ask", { matches: [pair(102, 11), pair(202, 22)] }, [
      read("catch-up"), call("list_conversations"), call("get_conversation", { chat_id: 11 }),
      { method: "trace_overflow" },
    ]).passed).toBe(false);
  });
});
