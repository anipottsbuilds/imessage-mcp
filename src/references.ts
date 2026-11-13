import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { ImessageMcpError } from "./errors.js";

// Seal exact page positions with a memory-only key; durable sync keeps its format.
const pageKey = randomBytes(32);
const PAGE_SEAL = "e1_";
const PAGE_AAD = Buffer.from("imessage-mcp:page:e1");
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
export type CursorKind = "page" | "sync";

export const MAX_CURSOR_LENGTH = 16_384;
export const MAX_SYNC_CURSOR_LENGTH = 128_000;

export function encodeCursor(kind: CursorKind, value: Record<string, unknown>): string {
  const plaintext = Buffer.from(JSON.stringify(value), "utf8");
  if (kind === "sync") return `im3_sync_${plaintext.toString("base64url")}`;
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv("aes-256-gcm", pageKey, nonce);
  cipher.setAAD(PAGE_AAD);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return `im3_page_${PAGE_SEAL}${Buffer.concat([nonce, cipher.getAuthTag(), ciphertext]).toString("base64url")}`;
}

export function decodeCursor(kind: CursorKind, encoded: unknown, maxLength = MAX_CURSOR_LENGTH): Record<string, unknown> {
  const prefix = `im3_${kind}_`;
  if (typeof encoded !== "string" || !encoded.startsWith(prefix) || encoded.length > maxLength) {
    throw new ImessageMcpError("INVALID_INPUT", `cursor is not a ${kind} cursor from this server`);
  }
  let body = encoded.slice(prefix.length);
  let plaintext: string | undefined;
  if (kind === "page" && body.startsWith(PAGE_SEAL)) {
    body = body.slice(PAGE_SEAL.length);
    if (!/^[A-Za-z0-9_-]+$/u.test(body)) {
      throw new ImessageMcpError("INVALID_INPUT", "cursor has invalid encoding");
    }
    const sealed = Buffer.from(body, "base64url");
    if (sealed.length <= NONCE_BYTES + TAG_BYTES || sealed.toString("base64url") !== body) {
      throw new ImessageMcpError("INVALID_INPUT", "cursor has invalid encoding");
    }
    try {
      const decipher = createDecipheriv("aes-256-gcm", pageKey, sealed.subarray(0, NONCE_BYTES));
      decipher.setAAD(PAGE_AAD);
      decipher.setAuthTag(sealed.subarray(NONCE_BYTES, NONCE_BYTES + TAG_BYTES));
      plaintext = Buffer.concat([decipher.update(sealed.subarray(NONCE_BYTES + TAG_BYTES)), decipher.final()]).toString("utf8");
    } catch {
      throw new ImessageMcpError("DATABASE_CHANGED", "page cursor is no longer valid; restart the traversal without a cursor");
    }
  }
  if (body.length === 0 || !/^[A-Za-z0-9_-]+$/u.test(body)) {
    throw new ImessageMcpError("INVALID_INPUT", "cursor has invalid encoding");
  }
  let value: unknown;
  try {
    // Accept legacy page input; subsequent pages emit sealed cursors.
    value = JSON.parse(plaintext ?? Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    throw new ImessageMcpError("INVALID_INPUT", "cursor has invalid encoding");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ImessageMcpError("INVALID_INPUT", "cursor has an invalid payload");
  }
  return value as Record<string, unknown>;
}

export function positiveId(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new ImessageMcpError("INVALID_INPUT", `${label} must be a positive integer`);
  }
  return value;
}
