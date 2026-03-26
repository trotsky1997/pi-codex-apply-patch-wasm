# Rebuilding `apply_patch.wasm`

This directory contains the helper script for rebuilding the bundled WASM binary used by `pi-codex-apply-patch-wasm`.

## What you need

This package does **not** include the upstream Rust sources for Codex `apply_patch`, so you need two things on your machine:

1. A checkout of the Codex Rust workspace containing `codex/codex-rs`
2. A local `wasi-sdk` installation

## Where to get them

### 1) Codex Rust workspace

Get a checkout of the upstream Codex repository that contains the `codex-rs` workspace and the `codex-apply-patch` crate.

You should end up with a directory like:

```text
/path/to/codex/codex-rs
```

The rebuild script expects the path to the `codex-rs` directory itself.

### 2) WASI SDK

Install or download a WASI SDK release from the official WebAssembly/wasi-sdk project:

- https://github.com/WebAssembly/wasi-sdk
- https://github.com/WebAssembly/wasi-sdk/releases

After extracting it, you should have a directory like:

```text
/path/to/wasi-sdk-32.0-x86_64-linux
```

The script needs the SDK root directory, which contains:

- `bin/clang`
- `bin/llvm-ar`
- `share/wasi-sysroot`

## Other prerequisites

You also need these tools installed locally:

- `rustup`
- `python`
- a Rust toolchain that `rustup` can install from the `codex-rs/rust-toolchain.toml` file

The script will automatically run `rustup target add wasm32-wasip1` for the pinned toolchain.

## Rebuild command

From the package root:

```bash
./scripts/rebuild-codex-apply-patch-wasm.sh \
  --codex-rs-dir /path/to/codex/codex-rs \
  --wasi-sdk-dir /path/to/wasi-sdk-32.0-x86_64-linux
```

To build a release binary instead of debug:

```bash
./scripts/rebuild-codex-apply-patch-wasm.sh \
  --release \
  --codex-rs-dir /path/to/codex/codex-rs \
  --wasi-sdk-dir /path/to/wasi-sdk-32.0-x86_64-linux
```

## What the script does

- reads the pinned Rust toolchain from `codex-rs/rust-toolchain.toml`
- configures the WASI C toolchain environment variables
- builds `codex-apply-patch` for `wasm32-wasip1`
- copies the result into:

```text
vendor/apply_patch.wasm
```

## Verify the result

After rebuilding, you can verify that the extension still works by loading it in pi and running the included self-test:

```bash
pi -e .
/apply-patch-selftest
```

Or install it and test in a normal session:

```bash
pi install /absolute/path/to/pi-codex-apply-patch-wasm
```
