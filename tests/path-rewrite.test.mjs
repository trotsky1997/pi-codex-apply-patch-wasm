import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

import { detectAbsolutePatchPath, parsePatch, preparePatchInput, serializePatch } from "../patch-format.ts";

test("rewrites cwd-contained absolute paths to relative paths", () => {
  const cwd = "/tmp/worktree";
  const patch = [
    "*** Begin Patch",
    "*** Update File: /tmp/worktree/src/app.ts",
    "@@",
    "-old",
    "+new",
    "*** End Patch",
  ].join("\n");

  const prepared = preparePatchInput(patch, cwd);
  assert.equal(prepared.error, undefined);
  assert.equal(
    prepared.patch,
    [
      "*** Begin Patch",
      "*** Update File: src/app.ts",
      "@@",
      "-old",
      "+new",
      "*** End Patch",
    ].join("\n"),
  );
});

test("rejects absolute paths outside cwd", () => {
  const cwd = "/tmp/worktree";
  const patch = [
    "*** Begin Patch",
    "*** Delete File: /tmp/elsewhere/app.ts",
    "*** End Patch",
  ].join("\n");

  const prepared = preparePatchInput(patch, cwd);
  assert.match(prepared.error ?? "", /outside the current working directory/);
});

test("rewrites absolute move targets inside cwd", () => {
  const cwd = "/tmp/worktree";
  const patch = [
    "*** Begin Patch",
    "*** Update File: /tmp/worktree/src/old.ts",
    "*** Move to: /tmp/worktree/src/new.ts",
    "@@",
    "-old",
    "+new",
    "*** End Patch",
  ].join("\n");

  const prepared = preparePatchInput(patch, cwd);
  assert.equal(prepared.error, undefined);
  assert.equal(
    prepared.patch,
    [
      "*** Begin Patch",
      "*** Update File: src/old.ts",
      "*** Move to: src/new.ts",
      "@@",
      "-old",
      "+new",
      "*** End Patch",
    ].join("\n"),
  );
});

test("rejects absolute move targets outside cwd", () => {
  const cwd = "/tmp/worktree";
  const patch = [
    "*** Begin Patch",
    "*** Update File: src/old.ts",
    "*** Move to: /tmp/elsewhere/new.ts",
    "@@",
    "-old",
    "+new",
    "*** End Patch",
  ].join("\n");

  const prepared = preparePatchInput(patch, cwd);
  assert.match(prepared.error ?? "", /outside the current working directory/);
});

test("detects both POSIX and Windows absolute paths", () => {
  assert.equal(detectAbsolutePatchPath("/tmp/worktree/file.ts"), "posix");
  assert.equal(detectAbsolutePatchPath("C:\\worktree\\file.ts"), "win32");
  assert.equal(detectAbsolutePatchPath("\\\\server\\share\\file.ts"), "win32");
  assert.equal(detectAbsolutePatchPath("src/file.ts"), null);
});

test("rejects malformed patch envelope and trailing content", () => {
  const missingBegin = preparePatchInput("*** Update File: src/a.ts\n@@\n-old\n+new\n*** End Patch", "/tmp/worktree");
  assert.match(missingBegin.error ?? "", /non-apply_patch input/);

  const trailing = preparePatchInput(
    [
      "*** Begin Patch",
      "*** Delete File: src/a.ts",
      "*** End Patch",
      "oops",
    ].join("\n"),
    "/tmp/worktree",
  );
  assert.match(trailing.error ?? "", /unexpected content after/);
});

test("rejects malformed file sections and empty paths", () => {
  const malformed = preparePatchInput(
    [
      "*** Begin Patch",
      "*** Update File: src/a.ts",
      "not-a-hunk",
      "*** End Patch",
    ].join("\n"),
    "/tmp/worktree",
  );
  assert.match(malformed.error ?? "", /does not match the expected/);

  const emptyPath = preparePatchInput(
    [
      "*** Begin Patch",
      "*** Delete File:    ",
      "*** End Patch",
    ].join("\n"),
    "/tmp/worktree",
  );
  assert.match(emptyPath.error ?? "", /empty file path/);
});

test("platform-mismatch absolute paths are rejected with explicit runner errors", () => {
  const cwd = process.platform === "win32" ? "C:\\worktree" : "/tmp/worktree";
  const foreignAbsolutePath = process.platform === "win32" ? "/tmp/worktree/file.ts" : "C:\\worktree\\file.ts";
  const prepared = preparePatchInput(
    [
      "*** Begin Patch",
      `*** Delete File: ${foreignAbsolutePath}`,
      "*** End Patch",
    ].join("\n"),
    cwd,
  );

  assert.match(prepared.error ?? "", /not supported by this .* WASM runner/);
});

test("preserves end-of-file marker when serializing rewritten patches", () => {
  const patch = [
    "*** Begin Patch",
    "*** Update File: src/file.ts",
    "@@",
    "+tail",
    "*** End of File",
    "*** End Patch",
  ].join("\n");

  const parsed = parsePatch(patch);
  assert.ok(parsed);
  assert.equal(serializePatch(parsed), patch);
});

test("parse and serialize preserve rewrite-stable patches", () => {
  const cwd = process.platform === "win32" ? "C:\\repo" : "/tmp/repo";
  const absolutePath = path.join(cwd, "src", "feature.ts");
  const patch = [
    "*** Begin Patch",
    `*** Update File: ${absolutePath}`,
    "@@ feature",
    "-old",
    "+new",
    "*** End Patch",
  ].join("\n");

  const prepared = preparePatchInput(patch, cwd);
  assert.equal(prepared.error, undefined);
  const reparsed = parsePatch(prepared.patch);
  assert.ok(reparsed);
  assert.equal(serializePatch(reparsed), prepared.patch);
});
