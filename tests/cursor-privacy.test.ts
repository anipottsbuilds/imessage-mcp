import { describe, expect, it, vi } from "vitest";
import { decodeCursor, encodeCursor, MAX_CURSOR_LENGTH } from "../src/references.js";
import { successResult } from "../src/result.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "../src/sqlite.js";
import { LocalToolRuntime } from "../src/runtime.js";

const position = {
  frozen: { data_version: 1, max_message_id: 12345, max_edited_at: "815000000123456789" },
  after_date: "815000000123456789", after_chat: 42, after_rowid: 12345,
};
describe("private page cursors", () => {
  it("round-trips page positions without exposing their JSON or deterministic ciphertext", () => {
    const first = encodeCursor("page", position);
    const second = encodeCursor("page", position);
    expect(first).toMatch(/^im3_page_e1_/u);
    expect(first).not.toBe(second);
    expect(first.length).toBeLessThan(MAX_CURSOR_LENGTH);
    expect(decodeCursor("page", first)).toEqual(position);
    const decodedBytes = Buffer.from(first.slice("im3_page_e1_".length), "base64url").toString("utf8");
    expect(decodedBytes).not.toContain(position.after_date);
    expect(decodedBytes).not.toContain("after_chat");
    expect(() => JSON.parse(decodedBytes)).toThrow();
  });
  for (const privacy of ["redacted", "aggregate"] as const) {
    for (const tool of ["list_conversations", "get_conversation", "search_messages"]) {
      it(`keeps ${tool} page metadata opaque in ${privacy} output and resumable`, () => {
        const cursor = encodeCursor("page", position);
        const result = successResult({ tool, privacy, maskingKey: Buffer.alloc(32, 7), effectiveScope: {},
          data: {}, page: { next_cursor: cursor, has_more: true, as_of: "opaque-watermark" } });
        expect(JSON.stringify(result)).not.toContain(position.after_date);
        expect(JSON.stringify(result)).not.toContain("after_chat");
        const structured = result.structuredContent as { page: { next_cursor: string } };
        expect(structured.page.next_cursor).toBe(cursor);
        expect(decodeCursor("page", structured.page.next_cursor)).toEqual(position);
        expect(result.content[0]).toEqual({ type: "text", text: JSON.stringify(result.structuredContent) });
      });
    }
  }
  it("rejects tampering, malformed encoding, oversized inputs and wrong cursor kinds", () => {
    const prefix = "im3_page_e1_";
    const cursor = encodeCursor("page", position);
    const bytes = Buffer.from(cursor.slice(prefix.length), "base64url");
    bytes[bytes.length - 1] ^= 1;
    expect(() => decodeCursor("page", prefix + bytes.toString("base64url")))
      .toThrowError(expect.objectContaining({ reason: "DATABASE_CHANGED" }));
    for (const invalid of [prefix, prefix + "!", prefix + "AA", cursor + "x".repeat(MAX_CURSOR_LENGTH)]) {
      expect(() => decodeCursor("page", invalid)).toThrowError(expect.objectContaining({ reason: "INVALID_INPUT" }));
    }
    expect(() => decodeCursor("sync", cursor)).toThrow();
  });
  it("accepts legacy page input but emits sealed output", () => {
    const legacy = "im3_page_" + Buffer.from(JSON.stringify(position)).toString("base64url");
    expect(decodeCursor("page", legacy)).toEqual(position);
    expect(encodeCursor("page", decodeCursor("page", legacy))).toMatch(/^im3_page_e1_/u);
  });
  for (const privacy of ["redacted", "aggregate"] as const) {
    it(`paginates real synthetic queries with sealed cursors at the ${privacy} ceiling`, async () => {
      const directory = mkdtempSync(path.join(tmpdir(), "imessage-cursor-test-"));
      const databasePath = path.join(directory, "chat.db");
      const db = new Database(databasePath);
      db.exec(`
        CREATE TABLE message (ROWID INTEGER PRIMARY KEY, guid TEXT, handle_id INTEGER, date INTEGER, is_from_me INTEGER, text TEXT, service TEXT);
        CREATE TABLE handle (ROWID INTEGER PRIMARY KEY, id TEXT);
        CREATE TABLE chat (ROWID INTEGER PRIMARY KEY, guid TEXT);
        CREATE TABLE chat_message_join (chat_id INTEGER, message_id INTEGER);
        CREATE TABLE chat_handle_join (chat_id INTEGER, handle_id INTEGER);
        INSERT INTO handle VALUES (1, '+15550000001'), (2, '+15550000002');
        INSERT INTO chat VALUES (1, 'iMessage;+;one'), (2, 'iMessage;+;two');
        INSERT INTO chat_handle_join VALUES (1,1), (2,2);
        INSERT INTO message VALUES
          (1,'one',1,815000000123456789,0,'synthetic match one','iMessage'),
          (2,'two',1,815000001123456789,0,'synthetic match two','iMessage'),
          (3,'three',2,815000002123456789,0,'synthetic match three','iMessage');
        INSERT INTO chat_message_join VALUES (1,1), (1,2), (2,3);
      `);
      db.close();
      const runtime = new LocalToolRuntime({ database_path: databasePath, source_mode: "copy", contacts_mode: "none",
        privacy_ceiling: privacy, transport: "stdio", port: 3000 });
      try {
        for (const [tool, params] of [
          ["list_conversations", {}], ["get_conversation", { chat_id: 1 }],
          ["search_messages", { query: "synthetic", mode: "substring", scopes: ["text"], order: "newest" }],
        ] as const) {
          const first = await runtime.call(tool, { ...params, limit: 1, allow_partial: true });
          expect(first.isError, JSON.stringify(first)).not.toBe(true);
          const envelope = first.structuredContent as { page: { next_cursor: string; has_more: boolean } };
          expect(envelope.page.has_more).toBe(true);
          expect(envelope.page.next_cursor).toMatch(/^im3_page_e1_/u);
          const second = await runtime.call(tool, { ...params, limit: 1, allow_partial: true, cursor: envelope.page.next_cursor });
          expect(second.isError, JSON.stringify(second)).not.toBe(true);
          expect(JSON.stringify(first)).not.toContain("81500000");
        }
      } finally { runtime.close(); rmSync(directory, { recursive: true, force: true }); }
    });
  }
  it("requires restarting pages after key rotation without breaking durable sync cursors", async () => {
    const page = encodeCursor("page", position);
    const syncPosition = { v: 3, seq: 42, log: "opaque-log", db: "opaque-archive" };
    const sync = encodeCursor("sync", syncPosition);
    vi.resetModules();
    const restarted = await import("../src/references.js");
    expect(() => restarted.decodeCursor("page", page)).toThrowError(expect.objectContaining({ reason: "DATABASE_CHANGED" }));
    expect(restarted.decodeCursor("sync", sync)).toEqual(syncPosition);
  });
});
