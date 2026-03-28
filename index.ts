import { type ExtensionAPI, type ExtensionCommandContext, type Theme } from "@mariozechner/pi-coding-agent";
import { Container, Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parsePatch, preparePatchInput, type ParsedPatch, type PatchOperation } from "./patch-format.ts";

type ApplyPatchToolDetails = {
  cwd: string;
  wasmPath: string;
  stderr: string;
  exitCode: number;
};

type ApplyPatchRenderState = {
  patchKey?: string;
  parsedPatch?: ParsedPatch | null;
};

type ApplyPatchRenderContext = {
  args?: { patch?: string };
  expanded?: boolean;
  isError?: boolean;
  lastComponent?: unknown;
  state: ApplyPatchRenderState;
};

type ApplyPatchRenderResult = {
  content?: Array<{ type: string; text?: string }>;
  details?: ApplyPatchToolDetails;
};

type ApplyPatchRenderOptions = {
  isPartial?: boolean;
};

const EXTENSION_DIR = path.dirname(fileURLToPath(import.meta.url));
const VENDORED_WASM_PATH = path.join(EXTENSION_DIR, "vendor", "apply_patch.wasm");
const WORKSPACE_ROOT = path.resolve(EXTENSION_DIR, "../../..");
const RUNNER_PATH = path.join(EXTENSION_DIR, "runner.mjs");
const RELEASE_WASM_PATH = path.join(
  WORKSPACE_ROOT,
  "codex/codex-rs/target/wasm32-wasip1/release/apply_patch.wasm",
);
const DEBUG_WASM_PATH = path.join(
  WORKSPACE_ROOT,
  "codex/codex-rs/target/wasm32-wasip1/debug/apply_patch.wasm",
);

export default function applyPatchExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "apply_patch",
    label: "Apply Patch",
    description: [
      "Use the `apply_patch` tool to edit files.",
      "Your patch language is a stripped-down, file-oriented diff format designed to be easy to parse and safe to apply.",
      "Send the entire patch as a single string in `patch`.",
      "",
      "Patch format:",
      "- The patch must start with `*** Begin Patch` and end with `*** End Patch`.",
      "- Inside the patch, include one or more file operations.",
      "- Each file operation must start with exactly one of:",
      "  - `*** Add File: <relative path>`",
      "  - `*** Delete File: <relative path>`",
      "  - `*** Update File: <relative path>`",
      "- For `*** Update File`, you may optionally add `*** Move to: <new relative path>` immediately after the update header to rename the file.",
      "- Updated files must contain one or more hunks introduced by `@@`.",
      "- Inside a hunk, each line must begin with exactly one of:",
      "  - ` ` for context",
      "  - `-` for removed lines",
      "  - `+` for added lines",
      "- You may include `*** End of File` inside an update hunk when needed.",
      "",
      "Context rules for update hunks:",
      "- By default, include 3 lines of context before and after each change.",
      "- If a change is close to another change, do not duplicate overlapping context.",
      "- If 3 lines of context are not enough to uniquely identify the location, use an `@@` header such as `@@ class MyClass` or `@@ function myFunction`.",
      "- If needed, use multiple `@@` location markers to narrow down the target location.",
      "",
      "Rules for add, delete, and update:",
      "- `*** Add File` creates a new file. Every content line in the new file must start with `+`.",
      "- `*** Delete File` removes an existing file and has no following body lines.",
      "- `*** Update File` modifies an existing file in place.",
      "",
      "Path rules:",
      "- File paths must be relative paths only.",
      "- Never use absolute paths.",
      "",
      "Important:",
      "- Do not send prose, explanations, markdown fences, or JSON inside `patch`.",
      "- Send only the raw patch text.",
    ].join("\n"),
    promptSnippet: "Apply Codex-style file patches using the full patch envelope.",
    promptGuidelines: [
      "Use `apply_patch` when you need to make precise file edits in one or more files.",
      "Always send a complete raw patch string in `patch`, wrapped in `*** Begin Patch` and `*** End Patch`.",
      "For `*** Add File`, prefix every file content line with `+`.",
      "For `*** Update File`, include one or more `@@` hunks with context lines.",
      "Use only relative paths, never absolute paths.",
      "Do not include markdown code fences or extra explanation in the `patch` field.",
    ],
    parameters: Type.Object({
      patch: Type.String({
        description: [
          "The full contents of the apply_patch command as one string.",
          "Must start with `*** Begin Patch` and end with `*** End Patch`.",
          "Use only relative file paths.",
          "",
          "Grammar summary:",
          "Patch := Begin { FileOp } End",
          'Begin := "*** Begin Patch"',
          'End := "*** End Patch"',
          'FileOp := AddFile | DeleteFile | UpdateFile',
          'AddFile := "*** Add File: " path + newline + { "+" line }',
          'DeleteFile := "*** Delete File: " path',
          'UpdateFile := "*** Update File: " path + [ MoveTo ] + { Hunk }',
          'MoveTo := "*** Move to: " newPath',
          'Hunk := "@@" [ header ] + newline + { HunkLine } + [ "*** End of File" ]',
          'HunkLine := " " text | "-" text | "+" text',
          "",
          "Example:",
          "*** Begin Patch",
          "*** Add File: hello.txt",
          "+Hello world",
          "*** Update File: src/app.py",
          "@@ def greet():",
          '-print("Hi")',
          '+print("Hello, world!")',
          "*** Delete File: obsolete.txt",
          "*** End Patch",
        ].join("\n"),
      }),
    }),
    async execute(
      _toolCallId: string,
      params: { patch: string },
      _signal: AbortSignal,
      _onUpdate: unknown,
      ctx: { cwd: string },
    ) {
      const wasmPath = resolveWasmPath();
      const preparedPatch = preparePatchInput(params.patch, ctx.cwd);
      if (preparedPatch.error) {
        throw new Error(preparedPatch.error);
      }
      const result = await runApplyPatchWasm(wasmPath, ctx.cwd, preparedPatch.patch);

      if (result.exitCode !== 0) {
        throw new Error(formatFailure(result));
      }

      return {
        content: [{ type: "text", text: result.stdout }],
        details: {
          cwd: ctx.cwd,
          wasmPath,
          stderr: result.stderr,
          exitCode: result.exitCode,
        },
      };
    },
    renderCall(args: { patch?: string }, theme: Theme, context: ApplyPatchRenderContext) {
      const state = context.state;
      const parsed = getParsedPatch(state, args?.patch);
      const text = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
      text.setText(renderPatchCall(parsed, theme, Boolean(context.expanded)));
      return text;
    },
    renderResult(
      result: ApplyPatchRenderResult,
      options: ApplyPatchRenderOptions,
      theme: Theme,
      context: ApplyPatchRenderContext,
    ) {
      if (options.isPartial) {
        const text = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
        text.setText(theme.fg("warning", "Applying patch..."));
        return text;
      }

      if (context.isError) {
        const message = extractTextContent(result).trim();
        const text = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
        text.setText(theme.fg("error", message || "apply_patch failed"));
        return text;
      }

      const state = context.state;
      const parsed = getParsedPatch(state, context.args?.patch);
      if (parsed) {
        return new Container();
      }

      const fallback = renderResultFallback(result, theme);
      if (!fallback) {
        return new Container();
      }

      const text = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
      text.setText(fallback);
      return text;
    },
  });

  pi.registerCommand("apply-patch-selftest", {
    description: "Verify that the wasm-backed apply_patch extension can patch a temp file on this machine",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      const wasmPath = resolveWasmPath();
      const tempDir = await mkdtemp(path.join(os.tmpdir(), "pi-apply-patch-"));
      const fileName = "sample.txt";
      const filePath = path.join(tempDir, fileName);
      const patch = [
        "*** Begin Patch",
        `*** Update File: ${fileName}`,
        "@@",
        "-alpha",
        "+beta",
        "*** End Patch",
      ].join("\n");

      try {
        await writeFile(filePath, "alpha\n", "utf8");
        const result = await runApplyPatchWasm(wasmPath, tempDir, patch);
        const updated = await readFile(filePath, "utf8");
        const ok = result.exitCode === 0 && updated === "beta\n";

        if (!ok) {
          const message = [
            "apply_patch self-test failed.",
            `exitCode=${result.exitCode}`,
            `stdout=${JSON.stringify(result.stdout.trim())}`,
            `stderr=${JSON.stringify(result.stderr.trim())}`,
            `file=${JSON.stringify(updated)}`,
          ].join(" ");
          if (ctx.hasUI) {
            ctx.ui?.notify(message, "error");
          }
          throw new Error(message);
        }

        const message = `apply_patch self-test passed using ${wasmPath}`;
        if (ctx.hasUI) {
          ctx.ui?.notify(message, "info");
        }
      } finally {
        await rm(tempDir, { recursive: true, force: true });
      }
    },
  });
}

function resolveWasmPath(): string {
  if (existsSync(VENDORED_WASM_PATH)) {
    return VENDORED_WASM_PATH;
  }
  if (existsSync(RELEASE_WASM_PATH)) {
    return RELEASE_WASM_PATH;
  }
  if (existsSync(DEBUG_WASM_PATH)) {
    return DEBUG_WASM_PATH;
  }

  throw new Error(
    [
      "apply_patch.wasm not found.",
      `Expected one of: ${VENDORED_WASM_PATH}, ${RELEASE_WASM_PATH}, or ${DEBUG_WASM_PATH}`,
      "Rebuild it with: ./scripts/rebuild-codex-apply-patch-wasm.sh",
    ].join(" "),
  );
}

function runApplyPatchWasm(
  wasmPath: string,
  cwd: string,
  patch: string,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [RUNNER_PATH, cwd, wasmPath], {
      cwd: EXTENSION_DIR,
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
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({ stdout, stderr, exitCode: code ?? 1 });
    });

    child.stdin.on("error", reject);
    child.stdin.end(patch);
  });
}

function formatFailure(result: { stdout: string; stderr: string; exitCode: number }): string {
  const detail = (result.stderr || result.stdout || `apply_patch failed with exit code ${result.exitCode}`).trim();
  return detail || `apply_patch failed with exit code ${result.exitCode}`;
}

function getParsedPatch(state: ApplyPatchRenderState, patchText: unknown): ParsedPatch | null {
  const patch = typeof patchText === "string" ? patchText : "";
  if (state.patchKey !== patch) {
    state.patchKey = patch;
    state.parsedPatch = parsePatch(patch);
  }
  return state.parsedPatch ?? null;
}

function renderPatchCall(parsed: ParsedPatch | null, theme: Theme, expanded: boolean): string {
  const title = theme.fg("toolTitle", theme.bold("apply_patch"));
  if (!parsed) {
    return title;
  }

  const lines: string[] = [title + " " + renderPatchHeadline(parsed, theme)];

  if (parsed.operations.length > 1 && !expanded) {
    const maxCollapsed = Math.min(parsed.operations.length, 4);
    for (const operation of parsed.operations.slice(0, maxCollapsed)) {
      lines.push(`${theme.fg("dim", "  ")}${renderOperationSummary(operation, theme)}`);
    }
    if (parsed.operations.length > maxCollapsed) {
      lines.push(theme.fg("muted", `  ... ${parsed.operations.length - maxCollapsed} more files`));
    }
  }

  if (expanded) {
    for (const operation of parsed.operations) {
      lines.push("");
      lines.push(theme.fg("accent", renderTargetPath(operation)) + renderChangeCounts(operation, theme));
      lines.push(...renderOperationPreview(operation, theme));
    }
  }

  return lines.join("\n");
}

function renderPatchHeadline(parsed: ParsedPatch, theme: Theme): string {
  if (parsed.operations.length === 1) {
    const [operation] = parsed.operations;
    return `${renderVerb(operation)} ${theme.fg("accent", renderTargetPath(operation))}${renderChangeCounts(operation, theme)}`;
  }

  return `Edited ${parsed.operations.length} files${renderAggregateCounts(parsed, theme)}`;
}

function renderVerb(operation: PatchOperation): string {
  switch (operation.kind) {
    case "add":
      return "Added";
    case "delete":
      return "Deleted";
    default:
      return "Edited";
  }
}

function renderOperationSummary(operation: PatchOperation, theme: Theme): string {
  return `${theme.fg("accent", renderTargetPath(operation))}${renderChangeCounts(operation, theme)}`;
}

function renderTargetPath(operation: PatchOperation): string {
  return operation.movePath ? `${operation.path} -> ${operation.movePath}` : operation.path;
}

function renderAggregateCounts(parsed: ParsedPatch, theme: Theme): string {
  if (parsed.totalAdded === 0 && parsed.totalRemoved === 0) {
    return "";
  }

  return ` ${theme.fg("dim", "(")}${theme.fg("success", `+${parsed.totalAdded}`)} ${theme.fg("error", `-${parsed.totalRemoved}`)}${theme.fg("dim", ")")}`;
}

function renderChangeCounts(operation: PatchOperation, theme: Theme): string {
  if (operation.kind === "delete") {
    return ` ${theme.fg("dim", "(delete)")}`;
  }
  if (operation.added === 0 && operation.removed === 0) {
    return "";
  }

  return ` ${theme.fg("dim", "(")}${theme.fg("success", `+${operation.added}`)} ${theme.fg("error", `-${operation.removed}`)}${theme.fg("dim", ")")}`;
}

function renderOperationPreview(operation: PatchOperation, theme: Theme): string[] {
  const lines = buildGithubStylePreview(operation, theme);
  return lines.map((line) => (line.length > 0 ? `    ${line}` : ""));
}

function buildGithubStylePreview(operation: PatchOperation, theme: Theme): string[] {
  const targetPath = operation.movePath ?? operation.path;
  const sourcePath = operation.kind === "add" ? "/dev/null" : `a/${operation.path}`;
  const destinationPath = operation.kind === "delete" ? "/dev/null" : `b/${targetPath}`;
  const numberWidths = computePreviewNumberWidths(operation);
  const lines: string[] = [
    theme.fg("dim", `diff --git a/${operation.path} b/${targetPath}`),
  ];

  if (operation.kind === "add") {
    lines.push(theme.fg("dim", "new file mode 100644"));
  } else if (operation.kind === "delete") {
    lines.push(theme.fg("dim", "deleted file mode 100644"));
  } else if (operation.movePath) {
    lines.push(theme.fg("dim", `rename from ${operation.path}`));
    lines.push(theme.fg("dim", `rename to ${operation.movePath}`));
  }

  lines.push(theme.fg("toolDiffRemoved", `--- ${sourcePath}`));
  lines.push(theme.fg("toolDiffAdded", `+++ ${destinationPath}`));

  if (operation.kind === "delete") {
    lines.push(theme.fg("dim", formatUnifiedHeader(1, 0, 0, 0)));
    lines.push(theme.fg("muted", "(file content is not included in delete-only apply_patch operations)"));
    return lines;
  }

  let oldLine = operation.kind === "add" ? 0 : 1;
  let newLine = 1;

  for (const [index, hunk] of operation.hunks.entries()) {
    if (index > 0) {
      lines.push("");
    }
    const range = computeUnifiedRange(hunk, oldLine, newLine);
    lines.push(theme.fg("dim", formatGithubHunkHeader(range, hunk.header)));
    lines.push(...renderGithubHunkLines(hunk, range, numberWidths, theme));
    oldLine = range.nextOldLine;
    newLine = range.nextNewLine;
  }

  return lines;
}

function formatGithubHunkHeader(
  range: { oldStart: number; oldCount: number; newStart: number; newCount: number },
  header: string,
): string {
  const title = formatUnifiedHeader(range.oldStart, range.oldCount, range.newStart, range.newCount);
  return header ? `${title} ${header}` : title;
}

function formatUnifiedHeader(oldStart: number, oldCount: number, newStart: number, newCount: number): string {
  return `@@ -${formatUnifiedRange(oldStart, oldCount)} +${formatUnifiedRange(newStart, newCount)} @@`;
}

function formatUnifiedRange(start: number, count: number): string {
  return count === 1 ? `${start}` : `${start},${count}`;
}

function computeUnifiedRange(
  hunk: PatchHunk,
  oldStart: number,
  newStart: number,
): { oldStart: number; oldCount: number; newStart: number; newCount: number; nextOldLine: number; nextNewLine: number } {
  let oldCount = 0;
  let newCount = 0;
  let nextOldLine = oldStart;
  let nextNewLine = newStart;

  for (const line of hunk.lines) {
    if (line.startsWith("-")) {
      oldCount += 1;
      nextOldLine += 1;
      continue;
    }
    if (line.startsWith("+")) {
      newCount += 1;
      nextNewLine += 1;
      continue;
    }
    oldCount += 1;
    newCount += 1;
    nextOldLine += 1;
    nextNewLine += 1;
  }

  return { oldStart, oldCount, newStart, newCount, nextOldLine, nextNewLine };
}

function computePreviewNumberWidths(operation: PatchOperation): { oldWidth: number; newWidth: number } {
  let oldMax = 0;
  let newMax = 0;
  let oldLine = operation.kind === "add" ? 0 : 1;
  let newLine = 1;

  for (const hunk of operation.hunks) {
    const range = computeUnifiedRange(hunk, oldLine, newLine);
    oldMax = Math.max(oldMax, range.nextOldLine - 1);
    newMax = Math.max(newMax, range.nextNewLine - 1);
    oldLine = range.nextOldLine;
    newLine = range.nextNewLine;
  }

  return {
    oldWidth: Math.max(String(oldMax || 0).length, 1),
    newWidth: Math.max(String(newMax || 0).length, 1),
  };
}

function renderGithubHunkLines(
  hunk: PatchHunk,
  range: { oldStart: number; newStart: number },
  widths: { oldWidth: number; newWidth: number },
  theme: Theme,
): string[] {
  const lines: string[] = [];
  let oldLine = range.oldStart;
  let newLine = range.newStart;

  for (const rawLine of hunk.lines) {
    const marker = rawLine[0];
    let oldNumber = "";
    let newNumber = "";

    if (marker === " " || marker === "-") {
      oldNumber = String(oldLine);
      oldLine += 1;
    }
    if (marker === " " || marker === "+") {
      newNumber = String(newLine);
      newLine += 1;
    }

    const oldColumn = theme.fg("dim", oldNumber.padStart(widths.oldWidth, " "));
    const newColumn = theme.fg("dim", newNumber.padStart(widths.newWidth, " "));
    const gutter = theme.fg("dim", " | ");
    lines.push(`${oldColumn} ${newColumn}${gutter}${colorGithubDiffLine(rawLine, theme)}`);
  }

  return lines;
}

function colorGithubDiffLine(line: string, theme: Theme): string {
  if (line.startsWith("+")) {
    return theme.fg("toolDiffAdded", line);
  }
  if (line.startsWith("-")) {
    return theme.fg("toolDiffRemoved", line);
  }
  return theme.fg("toolDiffContext", line);
}

function renderResultFallback(
  result: { content?: Array<{ type: string; text?: string }>; details?: ApplyPatchToolDetails },
  theme: Theme,
): string {
  const output = extractTextContent(result).trim();
  if (!output) {
    return "";
  }

  const lines = output.split("\n");
  if (lines[0] === "Success. Updated the following files:") {
    const rendered = [theme.fg("success", "Patch applied")];
    for (const line of lines.slice(1)) {
      if (line.length < 3) {
        continue;
      }
      rendered.push(`${theme.fg("dim", "  ")}${theme.fg("muted", line.slice(0, 2))}${theme.fg("accent", line.slice(2))}`);
    }
    return rendered.join("\n");
  }

  return theme.fg("toolOutput", output);
}

function extractTextContent(result: { content?: Array<{ type: string; text?: string }> }): string {
  return (result.content ?? [])
    .filter((part) => part.type === "text")
    .map((part) => part.text ?? "")
    .join("\n");
}
