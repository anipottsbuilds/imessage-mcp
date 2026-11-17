#!/usr/bin/env node

// Install and exercise the exact packed artifact, outside the source checkout.
// All protocol calls use synthetic databases, never live data.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repository = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
if (process.argv.length !== 3) throw new Error("usage: npm run test:package -- <packed.tgz>");
const tarball = path.resolve(process.argv[2]);
if (!statSync(tarball).isFile()) throw new Error("the package artifact must be a file");
const root = mkdtempSync(path.join(tmpdir(), "imessage-mcp-package-test-"));
try {
  execFileSync("npm", ["install", "--prefix", root, "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund", tarball], {
    cwd: root, stdio: "inherit",
  });
  const installedRoot = path.join(root, "node_modules", "imessage-mcp");
  const expected = JSON.parse(readFileSync(path.join(repository, "package.json"), "utf8"));
  const installed = JSON.parse(readFileSync(path.join(installedRoot, "package.json"), "utf8"));
  if (installed.name !== expected.name || installed.version !== expected.version) {
    throw new Error("installed artifact identity differs from the release checkout");
  }
  execFileSync(process.execPath, [path.join(repository, "node_modules", "vitest", "vitest.mjs"), "run", "--config", "vitest.e2e.config.ts"], {
    cwd: repository,
    stdio: "inherit",
    env: { ...process.env, NODE_PATH: "", IMESSAGE_E2E_PACKAGE_ROOT: installedRoot },
  });
} finally {
  rmSync(root, { recursive: true, force: true });
}
