// Node preload for the E2E child only. Keep the real index build pending at
// its decoder-session boundary until the parent has exercised the MCP wire.
import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";

const [root, gate] = [process.env.IMESSAGE_E2E_SERVER_ROOT, process.env.IMESSAGE_E2E_INDEX_GATE];
if (!root || !gate) throw new Error("index build test preload requires its isolated gate and server paths");
const { MessageTextDecoder } = await import(pathToFileURL(path.join(root, "dist", "decoder.js")).href);
const original = MessageTextDecoder.prototype.withSession;
MessageTextDecoder.prototype.withSession = async function (operation) {
  MessageTextDecoder.prototype.withSession = original;
  writeFileSync(path.join(gate, "entered"), "");
  while (!existsSync(path.join(gate, "released"))) await delay(10);
  return original.call(this, operation);
};
