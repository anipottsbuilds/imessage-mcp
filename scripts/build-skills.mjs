// Generate the release catalog from the exact UTF-8 bytes packaged for each skill.
import { readFileSync, writeFileSync } from "node:fs";
import { skillEntry } from "@modelcontextprotocol/server/ext/skills";

const catalog = [];
for (const name of ["catch-up", "find-it"]) {
  const bytes = readFileSync(new URL(`../skills/${name}/SKILL.md`, import.meta.url));
  const text = bytes.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(bytes)) throw new Error(`${name}/SKILL.md must be valid UTF-8`);
  catalog.push({ entry: await skillEntry(name, { "SKILL.md": bytes }), text });
}
writeFileSync(new URL("../dist/workflow-skills.json", import.meta.url), JSON.stringify(catalog) + "\n");
