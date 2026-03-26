import { type ExtensionAPI, type ExtensionCommandContext, type Theme } from "@mariozechner/pi-coding-agent";
import { Container, Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

type PatchOperationKind = "add" | "delete" | "update";

type PatchHunk = {
  header: string;
  lines: string[];
};

type PatchOperation = {
  kind: PatchOperationKind;
  path: string;
  movePath?: string;
  hunks: PatchHunk[];
  added: number;
  removed: number;
};

type ParsedPatch = {
  operations: PatchOperation[];
  totalAdded: number;
  totalRemoved: number;
};

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
    description:
      "Apply a Codex-style patch using the upstream codex-apply-patch wasm binary. Input must be the full patch text wrapped in *** Begin Patch / *** End Patch.",
    parameters: Type.Object({
      patch: Type.String({
        description:
          "The full patch text. Use Codex apply_patch format with Add File, Delete File, Update File, optional Move to, and @@ hunks.",
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
      const result = await runApplyPatchWasm(wasmPath, ctx.cwd, params.patch);

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

function parsePatch(patch: string): ParsedPatch | null {
  const lines = patch.replace(/\r\n?/g, "\n").split("\n");
  if (lines.length < 2 || lines[0].trim() !== "*** Begin Patch") {
    return null;
  }

  const operations: PatchOperation[] = [];
  let i = 1;

  while (i < lines.length) {
    const line = lines[i];

    if (line === "*** End Patch") {
      break;
    }

    if (line.length === 0) {
      i += 1;
      continue;
    }

    if (line.startsWith("*** Add File: ")) {
      const parsed = parseAddOperation(lines, i);
      if (!parsed) {
        return null;
      }
      operations.push(parsed.operation);
      i = parsed.nextIndex;
      continue;
    }

    if (line.startsWith("*** Delete File: ")) {
      operations.push({
        kind: "delete",
        path: line.slice("*** Delete File: ".length).trim(),
        hunks: [],
        added: 0,
        removed: 0,
      });
      i += 1;
      continue;
    }

    if (line.startsWith("*** Update File: ")) {
      const parsed = parseUpdateOperation(lines, i);
      if (!parsed) {
        return null;
      }
      operations.push(parsed.operation);
      i = parsed.nextIndex;
      continue;
    }

    return null;
  }

  if (operations.length === 0) {
    return null;
  }

  return {
    operations,
    totalAdded: operations.reduce((sum, operation) => sum + operation.added, 0),
    totalRemoved: operations.reduce((sum, operation) => sum + operation.removed, 0),
  };
}

function parseAddOperation(lines: string[], index: number): { operation: PatchOperation; nextIndex: number } | null {
  const pathText = lines[index].slice("*** Add File: ".length).trim();
  const contentLines: string[] = [];
  let i = index + 1;

  while (i < lines.length) {
    const line = lines[i];
    if (line === "*** End Patch" || isPatchSectionHeader(line)) {
      break;
    }
    if (!line.startsWith("+")) {
      return null;
    }
    contentLines.push(line.slice(1));
    i += 1;
  }

  return {
    operation: {
      kind: "add",
      path: pathText,
      hunks: [{ header: "", lines: contentLines.map((content) => `+${content}`) }],
      added: contentLines.length,
      removed: 0,
    },
    nextIndex: i,
  };
}

function parseUpdateOperation(lines: string[], index: number): { operation: PatchOperation; nextIndex: number } | null {
  const pathText = lines[index].slice("*** Update File: ".length).trim();
  let movePath: string | undefined;
  let i = index + 1;

  if (i < lines.length && lines[i].startsWith("*** Move to: ")) {
    movePath = lines[i].slice("*** Move to: ".length).trim();
    i += 1;
  }

  const hunks: PatchHunk[] = [];
  while (i < lines.length) {
    const line = lines[i];
    if (line === "*** End Patch" || isPatchSectionHeader(line)) {
      break;
    }
    if (!line.startsWith("@@")) {
      return null;
    }

    const hunk: PatchHunk = {
      header: line === "@@" ? "" : line.slice(2).trim(),
      lines: [],
    };
    i += 1;

    while (i < lines.length) {
      const hunkLine = lines[i];
      if (hunkLine === "*** End Patch" || isPatchSectionHeader(hunkLine) || hunkLine.startsWith("@@")) {
        break;
      }
      if (hunkLine === "*** End of File") {
        i += 1;
        continue;
      }

      const marker = hunkLine[0];
      if (marker !== " " && marker !== "+" && marker !== "-") {
        return null;
      }
      hunk.lines.push(hunkLine);
      i += 1;
    }

    hunks.push(hunk);
  }

  if (hunks.length === 0) {
    return null;
  }

  let added = 0;
  let removed = 0;
  for (const hunk of hunks) {
    for (const hunkLine of hunk.lines) {
      if (hunkLine.startsWith("+")) {
        added += 1;
      } else if (hunkLine.startsWith("-")) {
        removed += 1;
      }
    }
  }

  return {
    operation: {
      kind: "update",
      path: pathText,
      movePath,
      hunks,
      added,
      removed,
    },
    nextIndex: i,
  };
}

function isPatchSectionHeader(line: string): boolean {
  return line.startsWith("*** Add File: ") || line.startsWith("*** Delete File: ") || line.startsWith("*** Update File: ");
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
    lines.push(theme.fg("dim", "@@ file removed @@"));
    return lines;
  }

  for (const [index, hunk] of operation.hunks.entries()) {
    if (index > 0) {
      lines.push("");
    }
    lines.push(theme.fg("dim", formatGithubHunkHeader(hunk.header)));
    for (const rawLine of hunk.lines) {
      lines.push(colorGithubDiffLine(rawLine, theme));
    }
  }

  return lines;
}

function formatGithubHunkHeader(header: string): string {
  return header ? `@@ ${header} @@` : "@@";
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
