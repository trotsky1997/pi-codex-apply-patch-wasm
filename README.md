# pi-codex-apply-patch-wasm

A pi extension package that exposes the upstream Codex `apply_patch` WASM binary as an `apply_patch` tool, with Codex-style patch summaries and diff previews in the TUI.

## Install

Local path:

```bash
pi install /absolute/path/to/pi-codex-apply-patch-wasm
pi install ./.pi/extensions/apply-patch
```

GitHub:

```bash
pi install git:github.com/trotsky1997/pi-codex-apply-patch-wasm
```

Project-local install:

```bash
pi install -l ./.pi/extensions/apply-patch
```

After install, restart pi or use `/reload` in an active session.

## What it provides

- `apply_patch` tool compatible with the Codex patch envelope
- Codex-style path preparation before execution
- bundled `apply_patch.wasm` for standalone installs
- compact patch summaries in collapsed tool rows
- expanded diff previews for multi-file and code patches
- `/apply-patch-selftest` command to verify the WASM runner locally

## Path handling

The extension now mirrors the upstream Codex path flow more closely before handing work to the bundled WASM runner:

- relative patch paths are kept as-is and resolved by the runner against the active `cwd`
- missing `*** Begin Patch` / `*** End Patch` lines are safely restored when the patch body is otherwise valid
- footer lines such as `  *** End Patch  ` are normalized, and trailing chatty text after the footer is ignored
- absolute paths that stay inside the current `cwd` are rewritten back to relative paths before execution
- absolute paths outside the current `cwd` are rejected with a runner-specific error because this standalone WASM setup only preopens the current working directory
- `*** End of File` markers are preserved when a patch needs to be rewritten

This means the tool behaves closer to Codex for path normalization, while still making the WASM runner's sandbox limits explicit.

## Development

The package prefers the bundled `vendor/apply_patch.wasm`. If that file is missing, it falls back to a local workspace build at:

- `codex/codex-rs/target/wasm32-wasip1/release/apply_patch.wasm`
- `codex/codex-rs/target/wasm32-wasip1/debug/apply_patch.wasm`

To refresh the bundled binary from this workspace build:

```bash
cp codex/codex-rs/target/wasm32-wasip1/debug/apply_patch.wasm .pi/extensions/apply-patch/vendor/apply_patch.wasm
```

Or use the bundled rebuild script and point it at an existing `codex/codex-rs` checkout:

```bash
./scripts/rebuild-codex-apply-patch-wasm.sh \
  --codex-rs-dir /path/to/codex/codex-rs \
  --wasi-sdk-dir /path/to/wasi-sdk-32.0-x86_64-linux
```

Run the focused path-handling smoke tests with:

```bash
npm test
```
