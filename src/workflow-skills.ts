import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SkillsExtension, type Skill } from "@modelcontextprotocol/server/ext/skills";

// Source-mode development needs no dist directory. Release builds always use
// the immutable catalog produced from the packaged files by build-skills.mjs.
async function loadWorkflowSkills(): Promise<SkillsExtension> {
  if (import.meta.url.endsWith(".ts")) {
    const { loadSkills } = await import("@modelcontextprotocol/server/ext/skills/node");
    return loadSkills(fileURLToPath(new URL("../skills/", import.meta.url)), { strict: true });
  }

  const catalog = JSON.parse(readFileSync(new URL("./workflow-skills.json", import.meta.url), "utf8")) as Array<{
    entry: Skill;
    text: string;
  }>;
  const byUri = new Map(catalog.map(({ entry, text }) => [entry.uri, { entry, text }]));
  return new SkillsExtension({
    strict: true,
    source: {
      async list() {
        return { skills: catalog.map(({ entry }) => entry) };
      },
      async get(uri) {
        return byUri.get(uri)?.entry;
      },
      async read(uri) {
        const record = byUri.get(uri);
        return record ? { text: record.text, mimeType: "text/markdown" } : undefined;
      },
    },
  });
}

export const workflowSkills = await loadWorkflowSkills();
