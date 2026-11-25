import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { SkillsClient } from "@modelcontextprotocol/client/ext/skills";
import { expect, it, vi } from "vitest";
import { createMcpServer, type ToolRuntime } from "../src/server.js";

it("serves only the two fixed instruction documents without touching the archive", async () => {
  const call = vi.fn(() => { throw new Error("workflow discovery must not access Messages"); });
  const server = createMcpServer({ call } as unknown as ToolRuntime);
  const client = new Client({ name: "workflow-skills-test", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const skills = new SkillsClient(client);
    const { skills: entries } = await skills.list();
    expect(entries.map(({ frontmatter }) => frontmatter.name)).toEqual(["catch-up", "find-it"]);
    for (const entry of entries) {
      const bytes = readFileSync(new URL(`../skills/${entry.frontmatter.name}/SKILL.md`, import.meta.url));
      expect(entry.resources).toEqual([{
        uri: entry.uri,
        size: bytes.length,
        digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
      }]);
      expect((await skills.get(entry.uri)).skill).toEqual(entry);
      expect(Buffer.from((await skills.read(entry)).bytes)).toEqual(bytes);
    }
    await expect(client.readResource({ uri: "skill://find-it/NOT-A-SKILL.md" })).rejects.toThrow();
    expect(call).not.toHaveBeenCalled();
  } finally {
    await client.close();
    await server.close();
  }
});
