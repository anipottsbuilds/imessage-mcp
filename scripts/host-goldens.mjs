#!/usr/bin/env node
// Optional interactive Claude Code check. Only generated local fixtures are used.
import { spawn } from "node:child_process";
import {
  appendFileSync, closeSync, constants, existsSync, fstatSync, lstatSync, mkdtempSync,
  openSync, readFileSync, readSync, realpathSync, rmSync, writeFileSync,
} from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(import.meta.url);
const repo = path.dirname(path.dirname(script));
const phrase = "The purple telescope is in locker cobalt.";
// MCP hosts may scrub TMPDIR on spawn, so use the same canonical root in both processes.
const tempRoot = realpathSync("/tmp");
const casePrefix = "imessage-host-golden-";
const traceLimit = { bytes: 32 * 1024, records: 200 };
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
  const safe = !trace.some(x => x.method === "trace_overflow") &&
    calls.length > 0 && calls.every(x => readTools.has(x.tool));
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

function privateFile(file, flags, maximum) {
  const fd = openSync(file, flags | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  const stat = fstatSync(fd);
  if (!stat.isFile() || stat.uid !== process.getuid() || (stat.mode & 0o077) || stat.nlink !== 1 || stat.size > maximum) {
    closeSync(fd);
    throw new Error("Expected a bounded, private golden fixture file.");
  }
  return fd;
}

function readBounded(fd, maximum) {
  // Never read until EOF: another process might be appending to this file.
  const buffer = Buffer.alloc(maximum + 1);
  const bytes = readSync(fd, buffer, 0, buffer.length, 0);
  if (bytes > maximum) throw new Error("Golden fixture file exceeds the size limit.");
  return buffer.toString("utf8", 0, bytes);
}

function caseDirectory(directory) {
  const dir = path.resolve(directory);
  const stat = lstatSync(dir);
  if (path.dirname(dir) !== tempRoot || realpathSync(dir) !== dir ||
      !/^imessage-host-golden-[A-Za-z0-9]{6}$/u.test(path.basename(dir)) ||
      !stat.isDirectory() || stat.uid !== process.getuid() || (stat.mode & 0o077)) {
    throw new Error("Expected a private directory created by host-goldens prepare.");
  }
  const fd = privateFile(path.join(dir, "case.txt"), constants.O_RDONLY, 32);
  let name;
  try { name = readBounded(fd, 32); } finally { closeSync(fd); }
  if (!Object.hasOwn(cases, name)) throw new Error("Unknown golden case.");
  return { dir, name };
}

function prepare(name) {
  if (!Object.hasOwn(cases, name)) throw new Error("Unknown golden case.");
  const tmp = mkdtempSync(path.join(tempRoot, casePrefix));
  writeFileSync(path.join(tmp, "trace.jsonl"), "", { mode: 0o600 });
  writeFileSync(path.join(tmp, "case.txt"), name, { mode: 0o600 });
  console.log(tmp);
}

const skillUris = new Set(Object.values(cases).map(test => `skill://${test.skill}/SKILL.md`));
const searchModes = new Set(["exact", "phrase", "substring", "token"]);
const positiveId = value => Number.isSafeInteger(value) && value > 0 ? value : undefined;
export function traceRecord(request) {
  const method = request?.method;
  if (method === "skills/list" || method === "skills/get") return { method };
  if (method === "resources/read") {
    const uri = request.params?.uri;
    return { method, ...(skillUris.has(uri) ? { uri } : {}) };
  }
  if (method !== "tools/call") return undefined;
  const args = request.params?.arguments;
  const record = { method, tool: readTools.has(request.params?.name) ? request.params.name : "unexpected" };
  if (args && typeof args === "object") {
    if (searchModes.has(args.mode)) record.mode = args.mode;
    if (typeof args.replied === "boolean") record.replied = args.replied;
    if (positiveId(args.chat_id)) record.chat_id = args.chat_id;
    if (positiveId(args.around_message_id)) record.around_message_id = args.around_message_id;
    if (["person", "contact", "participant", "sender"].some(key => Object.hasOwn(args, key))) {
      record.has_person_filter = true;
    }
  }
  return record;
}

function relay(directory) {
  const { dir, name } = caseDirectory(directory);
  const bundled = path.join(repo, "bin", "imessage-mcp.js");
  if (!existsSync(path.join(repo, "dist", "cli.js"))) throw new Error("Run npm run build first.");
  const fd = privateFile(path.join(dir, "trace.jsonl"), constants.O_WRONLY | constants.O_APPEND, 0);
  const owned = mkdtempSync(path.join(tempRoot, "imessage-golden-db-"));
  const database = path.join(owned, "synthetic.db");
  try { buildFixture(name, database); }
  catch (error) { closeSync(fd); rmSync(owned, { recursive: true }); throw error; }
  const server = spawn(process.execPath, [bundled, "--database", database, "--contacts", "none"], {
    env: { ...process.env, IMESSAGE_UPDATE_CHECK: "0", IMESSAGE_CACHE: "0" },
    stdio: ["pipe", "pipe", "inherit"],
  });
  server.stdout.pipe(process.stdout);
  const input = readline.createInterface({ input: process.stdin });
  const overflow = '{"method":"trace_overflow"}\n';
  let records = 0, bytes = 0, limited = false;
  input.on("line", line => {
    let request;
    try { request = JSON.parse(line); } catch { /* The actual server handles malformed input. */ }
    const row = traceRecord(request);
    if (row && !limited) {
      const entry = JSON.stringify(row) + "\n";
      const size = Buffer.byteLength(entry);
      if (records + 1 >= traceLimit.records || bytes + size + overflow.length > traceLimit.bytes) {
        appendFileSync(fd, overflow);
        limited = true;
      } else {
        appendFileSync(fd, entry);
        records += 1;
        bytes += size;
      }
    }
    server.stdin.write(line + "\n");
  });
  input.on("close", () => server.stdin.end());
  server.on("error", () => { process.exitCode = 1; input.close(); });
  server.once("close", code => {
    input.close();
    closeSync(fd);
    rmSync(owned, { recursive: true });
    process.exitCode = code ?? 1;
  });
}

function launch(directory) {
  const { dir, name } = caseDirectory(directory);
  const test = cases[name];
  const command = `/imessage:${test.skill} ${test.prompt}`;
  console.log("Type the following as the first prompt in the interactive session:\n" + command);
  const allowed = [...readTools].map(tool => `mcp__imessage__${tool}`);
  const config = { mcpServers: { imessage: {
    type: "stdio", command: process.execPath, args: [script, "relay", dir],
  } } };
  const child = spawn(process.env.IMESSAGE_GOLDEN_CLAUDE || "claude", [
    "--strict-mcp-config", "--mcp-config", JSON.stringify(config),
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
    const { dir, name } = caseDirectory(value);
    const fd = privateFile(path.join(dir, "trace.jsonl"), constants.O_RDONLY, traceLimit.bytes);
    let trace;
    try { trace = readBounded(fd, traceLimit.bytes).trim().split("\n").filter(Boolean).map(JSON.parse); }
    finally { closeSync(fd); }
    if (trace.length > traceLimit.records) throw new Error("Golden trace exceeds the record limit.");
    const answer = JSON.parse(readFileSync(answerPath, "utf8"));
    const result = score(name, answer, trace);
    console.log(JSON.stringify(result));
    process.exitCode = result.passed ? 0 : 1;
  } else throw new Error("Usage: host-goldens.mjs prepare CASE | launch DIRECTORY | score DIRECTORY ANSWER.json");
}
