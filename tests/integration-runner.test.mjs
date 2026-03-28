import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { preparePatchInput } from "../patch-format.ts";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(TEST_DIR, "..");
const RUNNER_PATH = path.join(ROOT_DIR, "runner.mjs");
const WASM_PATH = path.join(ROOT_DIR, "vendor", "apply_patch.wasm");

test("runner applies nested multi-file patch across a real worktree", async () => {
  const worktree = await mkdtemp(path.join(os.tmpdir(), "pi-apply-patch-it-"));

  try {
    await mkdir(path.join(worktree, "src", "nested"), { recursive: true });
    await mkdir(path.join(worktree, "docs"), { recursive: true });
    await writeFile(path.join(worktree, "src", "nested", "feature.ts"), "export const value = 1;\n", "utf8");
    await writeFile(path.join(worktree, "docs", "obsolete.md"), "remove me\n", "utf8");

    const patch = [
      "*** Begin Patch",
      `*** Update File: ${path.join(worktree, "src", "nested", "feature.ts")}`,
      "@@",
      "-export const value = 1;",
      "+export const value = 2;",
      `*** Add File: ${path.join(worktree, "src", "nested", "created.ts")}`,
      "+export const created = true;",
      `*** Delete File: ${path.join(worktree, "docs", "obsolete.md")}`,
      "*** End Patch",
    ].join("\n");

    const prepared = preparePatchInput(patch, worktree);
    assert.equal(prepared.error, undefined);

    const result = await runRunner(worktree, prepared.patch);
    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /Success\. Updated the following files:/);
    assert.match(result.stdout, /M src\/nested\/feature\.ts/);
    assert.match(result.stdout, /A src\/nested\/created\.ts/);
    assert.match(result.stdout, /D docs\/obsolete\.md/);

    assert.equal(await readFile(path.join(worktree, "src", "nested", "feature.ts"), "utf8"), "export const value = 2;\n");
    assert.equal(await readFile(path.join(worktree, "src", "nested", "created.ts"), "utf8"), "export const created = true;\n");
    await assert.rejects(readFile(path.join(worktree, "docs", "obsolete.md"), "utf8"));
  } finally {
    await rm(worktree, { recursive: true, force: true });
  }
});

test("runner renames and updates a file across nested directories", async () => {
  const worktree = await mkdtemp(path.join(os.tmpdir(), "pi-apply-patch-it-"));

  try {
    await mkdir(path.join(worktree, "src", "old", "deep"), { recursive: true });
    await mkdir(path.join(worktree, "src", "new", "deeper"), { recursive: true });
    await writeFile(path.join(worktree, "src", "old", "deep", "module.ts"), "export const label = 'old';\n", "utf8");

    const sourcePath = path.join(worktree, "src", "old", "deep", "module.ts");
    const destPath = path.join(worktree, "src", "new", "deeper", "module-renamed.ts");
    const patch = [
      "*** Begin Patch",
      `*** Update File: ${sourcePath}`,
      `*** Move to: ${destPath}`,
      "@@",
      "-export const label = 'old';",
      "+export const label = 'new';",
      "*** End Patch",
    ].join("\n");

    const prepared = preparePatchInput(patch, worktree);
    assert.equal(prepared.error, undefined);

    const result = await runRunner(worktree, prepared.patch);
    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /M src\/new\/deeper\/module-renamed\.ts/);
    await assert.rejects(readFile(sourcePath, "utf8"));
    assert.equal(await readFile(destPath, "utf8"), "export const label = 'new';\n");
  } finally {
    await rm(worktree, { recursive: true, force: true });
  }
});

function runRunner(cwd, patch) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [RUNNER_PATH, cwd, WASM_PATH], {
      cwd: ROOT_DIR,
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        NODE_NO_WARNINGS: "1",
      },
      windowsHide: true,
    });

    let stdout = "";
    let stderr = "";

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({ exitCode: code ?? 1, stdout, stderr });
    });

    child.stdin.on("error", reject);
    child.stdin.end(patch);
  });
}
