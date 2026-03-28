import path from "node:path";

const BEGIN_PATCH_LINE = "*** Begin Patch";
const END_PATCH_LINE = "*** End Patch";

export type PatchOperationKind = "add" | "delete" | "update";

export type PatchHunk = {
  endOfFile: boolean;
  header: string;
  lines: string[];
};

export type PatchOperation = {
  kind: PatchOperationKind;
  path: string;
  movePath?: string;
  hunks: PatchHunk[];
  added: number;
  removed: number;
};

export type ParsedPatch = {
  operations: PatchOperation[];
  totalAdded: number;
  totalRemoved: number;
};

export function preparePatchInput(patch: string, cwd: string): { patch: string; error?: string } {
  const normalizedEnvelope = normalizePatchEnvelope(patch);
  if (normalizedEnvelope.error) {
    return { patch, error: normalizedEnvelope.error };
  }

  if (normalizedEnvelope.patch.trim().length === 0) {
    return { patch, error: "apply_patch handler received invalid patch input: patch is empty" };
  }

  const parsed = parsePatch(normalizedEnvelope.patch);
  if (!parsed) {
    return {
      patch,
      error: "apply_patch handler received invalid patch input: patch does not match the expected Add File / Delete File / Update File format",
    };
  }

  let needsRewrite = normalizedEnvelope.normalized;
  for (const operation of parsed.operations) {
    const rewrittenPath = rewritePatchPathForRunner(operation.path, cwd);
    if (rewrittenPath.error) {
      return { patch, error: rewrittenPath.error };
    }
    if (rewrittenPath.path !== operation.path) {
      operation.path = rewrittenPath.path;
      needsRewrite = true;
    }

    if (operation.movePath) {
      const rewrittenMovePath = rewritePatchPathForRunner(operation.movePath, cwd);
      if (rewrittenMovePath.error) {
        return { patch, error: rewrittenMovePath.error };
      }
      if (rewrittenMovePath.path !== operation.movePath) {
        operation.movePath = rewrittenMovePath.path;
        needsRewrite = true;
      }
    }
  }

  return { patch: needsRewrite ? serializePatch(parsed) : normalizedEnvelope.patch };
}

export function detectAbsolutePatchPath(pathText: string): "posix" | "win32" | null {
  if (path.posix.isAbsolute(pathText)) {
    return "posix";
  }

  if (path.win32.isAbsolute(pathText)) {
    return "win32";
  }

  return null;
}

export function serializePatch(parsed: ParsedPatch): string {
  const lines = [BEGIN_PATCH_LINE];

  for (const operation of parsed.operations) {
    if (operation.kind === "add") {
      lines.push(`*** Add File: ${operation.path}`);
      for (const hunk of operation.hunks) {
        lines.push(...hunk.lines);
      }
      continue;
    }

    if (operation.kind === "delete") {
      lines.push(`*** Delete File: ${operation.path}`);
      continue;
    }

    lines.push(`*** Update File: ${operation.path}`);
    if (operation.movePath) {
      lines.push(`*** Move to: ${operation.movePath}`);
    }
    for (const hunk of operation.hunks) {
      lines.push(hunk.header ? `@@ ${hunk.header}` : "@@");
      lines.push(...hunk.lines);
      if (hunk.endOfFile) {
        lines.push("*** End of File");
      }
    }
  }

  lines.push(END_PATCH_LINE);
  return lines.join("\n");
}

export function parsePatch(patch: string): ParsedPatch | null {
  const normalizedEnvelope = normalizePatchEnvelope(patch);
  if (normalizedEnvelope.error) {
    return null;
  }

  const lines = normalizedEnvelope.patch.split("\n");
  if (lines.length < 2 || lines[0] !== BEGIN_PATCH_LINE) {
    return null;
  }

  const operations: PatchOperation[] = [];
  let i = 1;

  while (i < lines.length) {
    const line = lines[i];

    if (line === END_PATCH_LINE) {
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

function normalizePatchEnvelope(patch: string): { patch: string; normalized: boolean; error?: string } {
  const normalizedNewlines = patch.replace(/\r\n?/g, "\n");
  if (normalizedNewlines.trim().length === 0) {
    return { patch: normalizedNewlines, normalized: normalizedNewlines !== patch };
  }

  const lines = normalizedNewlines.split("\n");
  let firstContentIndex = 0;
  while (firstContentIndex < lines.length && lines[firstContentIndex].trim().length === 0) {
    firstContentIndex += 1;
  }

  const firstContentLine = lines[firstContentIndex]?.trim();
  if (firstContentLine !== BEGIN_PATCH_LINE && !isPatchSectionHeader(lines[firstContentIndex] ?? "")) {
    return {
      patch,
      normalized: false,
      error: "apply_patch handler received non-apply_patch input: missing `*** Begin Patch` header",
    };
  }

  const envelopeLines =
    firstContentLine === BEGIN_PATCH_LINE
      ? [BEGIN_PATCH_LINE, ...lines.slice(firstContentIndex + 1)]
      : [BEGIN_PATCH_LINE, ...lines.slice(firstContentIndex)];

  const endPatchIndex = envelopeLines.findIndex((line, index) => index > 0 && line.trim() === END_PATCH_LINE);
  const normalizedLines =
    endPatchIndex >= 0
      ? [...envelopeLines.slice(0, endPatchIndex), END_PATCH_LINE]
      : [...envelopeLines, END_PATCH_LINE];
  const normalizedPatch = normalizedLines.join("\n");

  return {
    patch: normalizedPatch,
    normalized: normalizedPatch !== patch,
  };
}

function rewritePatchPathForRunner(pathText: string, cwd: string): { path: string; error?: string } {
  const trimmedPath = pathText.trim();
  if (trimmedPath.length === 0) {
    return {
      path: pathText,
      error: "apply_patch verification failed: encountered an empty file path",
    };
  }

  const absoluteFlavor = detectAbsolutePatchPath(trimmedPath);
  if (!absoluteFlavor) {
    return { path: pathText };
  }

  if (absoluteFlavor === "win32" && path.sep !== "\\") {
    return {
      path: pathText,
      error: `apply_patch verification failed: Windows absolute paths are not supported by this ${process.platform} WASM runner: ${JSON.stringify(trimmedPath)}`,
    };
  }

  if (absoluteFlavor === "posix" && path.sep === "\\") {
    return {
      path: pathText,
      error: `apply_patch verification failed: POSIX absolute paths are not supported by this Windows WASM runner: ${JSON.stringify(trimmedPath)}`,
    };
  }

  const relativePath = path.relative(cwd, trimmedPath);
  if (
    relativePath.length === 0 ||
    relativePath === "." ||
    relativePath.startsWith("..") ||
    path.isAbsolute(relativePath)
  ) {
    return {
      path: pathText,
      error: `apply_patch verification failed: absolute paths outside the current working directory are not supported by this WASM runner: ${JSON.stringify(trimmedPath)}`,
    };
  }

  return { path: relativePath };
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
      hunks: [{ endOfFile: false, header: "", lines: contentLines.map((content) => `+${content}`) }],
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
      endOfFile: false,
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
        hunk.endOfFile = true;
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
