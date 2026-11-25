#!/usr/bin/env node
// Optional interactive Claude Code check. Only generated local fixtures are used.
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import readline from "node:readline";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(import.meta.url);
const repo = path.dirname(path.dirname(script));
const phrase = "The purple telescope is in locker cobalt.";
const prefix = "Return only a JSON object with a matches array of {message_id,chat_id}. No prose. ";
export const cases = {
  "new-ask": {
    skill: "catch-up",
    prompt: prefix + "Evaluate as of November 24, 2026 at 23:00 UTC and read that day only. Include only explicit, outstanding requests addressed to me personally, in urgency order.",
    expected: [{ message_id: 102, chat_id: 11 }, { message_id: 202, chat_id: 22 }],
  },
  "cancelled-ask": {
    skill: "catch-up",
    prompt: prefix + "Evaluate as of November 24, 2026 at 23:00 UTC and read that day only. Include only explicit, outstanding requests addressed to me personally, in urgency order.",
    expected: [{ message_id: 202, chat_id: 22 }],
  },
  "specific-chat": {
    skill: "find-it",
    prompt: prefix + 'Find the exact text "' + phrase + '" from Blaire in November 24, 2026. Cite the verified message and chat.',
    expected: [{ message_id: 305, chat_id: 22 }],
  },
};

export function buildFixture(name, database) {
  if (!Object.hasOwn(cases, name)) throw new Error("Unknown golden case.");
  const db = new DatabaseSync(database);
  try {
    db.exec(`
      CREATE TABLE handle (ROWID INTEGER PRIMARY KEY, id TEXT NOT NULL, service TEXT);
      CREATE TABLE chat (
        ROWID INTEGER PRIMARY KEY, guid TEXT NOT NULL, style INTEGER, state INTEGER,
        chat_identifier TEXT, service_name TEXT, display_name TEXT, group_id TEXT
      );
      CREATE TABLE chat_message_join (
        chat_id INTEGER, message_id INTEGER, message_date INTEGER, index_state INTEGER DEFAULT 0,
        PRIMARY KEY (chat_id, message_id)
      );
      CREATE TABLE chat_handle_join (chat_id INTEGER, handle_id INTEGER);
      CREATE TABLE message (
        ROWID INTEGER PRIMARY KEY, guid TEXT NOT NULL, text TEXT, handle_id INTEGER,
        date INTEGER, is_from_me INTEGER, service TEXT
      );
      INSERT INTO handle VALUES
        (1,'avery@example.test','iMessage'),(2,'blaire@example.test','iMessage'),
        (3,'charlie@example.test','iMessage');
      INSERT INTO chat VALUES
        (11,'golden-chat-11',45,0,'avery@example.test','iMessage','Avery',NULL),
        (22,'golden-chat-22',45,0,'blaire@example.test','iMessage','Blaire',NULL),
        (33,'golden-chat-33',43,0,'golden-group','iMessage','Synthetic Group','golden-group');
      INSERT INTO chat_handle_join VALUES (11,1),(22,2),(33,1),(33,3);
    `);
    const message = db.prepare("INSERT INTO message VALUES (?,?,?,?,?,?,'iMessage')");
    const membership = db.prepare("INSERT INTO chat_message_join VALUES (?,?,?,0)");
    const add = (id, chats, sender, content, hour, minute) => {
      const time = BigInt((Date.UTC(2026, 10, 24, hour, minute) - Date.UTC(2001, 0, 1)) / 1000) * 1_000_000_000n;
      message.run(id, `golden-message-${id}`, content, sender, time, sender === null ? 1 : 0);
      for (const chat of chats) membership.run(chat, id, time);
    };
    if (name === "specific-chat") {
      // One result belongs to two chats; only chat 22 is Blaire's direct chat.
      add(304, [11], 1, phrase, 17, 15);
      add(305, [22, 33], 2, phrase, 17, 20);
      add(306, [22], null, "Thanks, I got your locker note.", 17, 22);
    } else {
      add(101, [11], null, "I'll send the old test notes when I get time.", 15, 10);
      add(102, [11], 1, "Could you send me the newer telescope checklist by November 25? I need it for my setup.", 16, 15);
      add(202, [22], 2, "Could you confirm your museum plan by November 29?", 16, 20);
      add(303, [33], 1, "Charlie, can you return the library books? This is for Charlie only.", 16, 30);
      if (name === "cancelled-ask") add(103, [11], 1, "Never mind about my newest telescope checklist request. I found it. No need to send it.", 16, 40);
    }
  } finally { db.close(); }
}

const readTools = new Set(["list_conversations", "get_conversation", "search_messages", "resolve_contact", "server_status"]);
export function score(name, answer, trace) {
  const test = cases[name];
  if (!test) throw new Error("Unknown golden case.");
  const expected = test.expected.map(x => [x.message_id, x.chat_id]);
  const seen = answer?.matches;
  const same = Array.isArray(seen) && seen.length === expected.length && expected.every(
    ([message, chat], index) => seen[index]?.message_id === message && seen[index]?.chat_id === chat,
  );
  const skillRead = trace.some(x => x.method === "resources/read" && x.uri === `skill://${test.skill}/SKILL.md`);
  const calls = trace.filter(x => x.method === "tools/call");
  const safe = calls.length > 0 && calls.every(x => readTools.has(x.tool));
  const behavior = name === "specific-chat"
    ? calls.some(x => x.tool === "search_messages" && x.mode === "exact") &&
      !calls.some(x => x.tool === "search_messages" && x.has_person_filter === true) &&
      calls.some(x => x.tool === "get_conversation" && x.chat_id === 22 && x.around_message_id === 305)
    : calls.some(x => x.tool === "list_conversations" && x.replied === undefined) &&
      !calls.some(x => x.tool === "list_conversations" && x.replied === false) &&
      calls.some(x => x.tool === "get_conversation" && x.chat_id === 11);
  return { passed: same && skillRead && safe && behavior, expected_matches: same, skill_read: skillRead,
    read_only_tools: safe, required_behavior: behavior };
}

function prepare(name) {
  if (!Object.hasOwn(cases, name)) throw new Error("Unknown golden case.");
  const tmp = mkdtempSync(path.join(tmpdir(), "imessage-host-golden-"));
  const database = path.join(tmp, "golden-chat.db");
  const trace = path.join(tmp, "trace.jsonl");
  buildFixture(name, database);
  writeFileSync(trace, "", { mode: 0o600 });
  const config = { mcpServers: { imessage: {
    type: "stdio", command: process.execPath, args: [script, "relay", tmp],
  } } };
  writeFileSync(path.join(tmp, "mcp.json"), JSON.stringify(config), { mode: 0o600 });
  writeFileSync(path.join(tmp, "case.txt"), name, { mode: 0o600 });
  console.log(tmp);
}

function relay(dir) {
  // The relay accepts only the database next to a known case marker, never a caller-supplied archive.
  const name = readFileSync(path.join(dir, "case.txt"), "utf8");
  if (!Object.hasOwn(cases, name) || !path.basename(dir).startsWith("imessage-host-golden-")) {
    throw new Error("Expected a prepared synthetic fixture.");
  }
  const bundled = path.join(repo, "bin", "imessage-mcp.js");
  if (!existsSync(path.join(repo, "dist", "cli.js"))) throw new Error("Run npm run build first.");
  const server = spawn(process.execPath, [bundled, "--database", path.join(dir, "golden-chat.db"), "--contacts", "none"], {
    env: { ...process.env, IMESSAGE_UPDATE_CHECK: "0", IMESSAGE_CACHE: "0" },
    stdio: ["pipe", "pipe", "inherit"],
  });
  server.stdout.pipe(process.stdout);
  const input = readline.createInterface({ input: process.stdin });
  input.on("line", line => {
    let request;
    try { request = JSON.parse(line); } catch { /* The actual server handles malformed input. */ }
    const method = request?.method;
    if (["skills/list", "skills/get", "resources/read", "tools/call"].includes(method)) {
      const args = request.params?.arguments ?? {};
      const row = { method, uri: request.params?.uri, tool: request.params?.name, mode: args.mode,
        replied: args.replied, chat_id: args.chat_id, around_message_id: args.around_message_id,
        has_person_filter: ["person", "contact", "participant", "sender"].some(key => Object.hasOwn(args, key)) };
      appendFileSync(path.join(dir, "trace.jsonl"), JSON.stringify(row) + "\n");
    }
    server.stdin.write(line + "\n");
  });
  input.on("close", () => server.stdin.end());
  server.on("error", () => { process.exitCode = 1; input.close(); });
  server.on("exit", code => { process.exitCode = code ?? 1; input.close(); });
}

function launch(dir) {
  const name = readFileSync(path.join(dir, "case.txt"), "utf8");
  const test = cases[name];
  if (!test) throw new Error("Unknown golden case.");
  const command = `/imessage:${test.skill} ${test.prompt}`;
  console.log("Type the following as the first prompt in the interactive session:\n" + command);
  const allowed = [...readTools].map(tool => `mcp__imessage__${tool}`);
  const child = spawn(process.env.IMESSAGE_GOLDEN_CLAUDE || "claude", [
    "--strict-mcp-config", "--mcp-config", path.join(dir, "mcp.json"),
    "--setting-sources", "", "--tools", "Skill", "--permission-mode", "manual",
    "--allowedTools", ...allowed,
  ], { cwd: dir, stdio: "inherit" });
  child.on("error", () => { process.exitCode = 1; });
  child.on("exit", code => { process.exitCode = code ?? 1; });
}

if (process.argv[1] && path.resolve(process.argv[1]) === script) {
  const [, , action, value, answerPath] = process.argv;
  if (action === "prepare") prepare(value);
  else if (action === "relay") relay(value);
  else if (action === "launch") launch(value);
  else if (action === "score") {
    const name = readFileSync(path.join(value, "case.txt"), "utf8");
    const trace = readFileSync(path.join(value, "trace.jsonl"), "utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
    const answer = JSON.parse(readFileSync(answerPath, "utf8"));
    const result = score(name, answer, trace);
    console.log(JSON.stringify(result));
    process.exitCode = result.passed ? 0 : 1;
  } else throw new Error("Usage: host-goldens.mjs prepare CASE | launch DIRECTORY | score DIRECTORY ANSWER.json");
}
