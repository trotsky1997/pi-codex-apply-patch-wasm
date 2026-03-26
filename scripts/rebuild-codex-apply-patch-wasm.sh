#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEFAULT_CODEX_RS_DIR="${CODEX_RS_DIR:-$ROOT_DIR/../../codex/codex-rs}"
CODEX_RS_DIR="$DEFAULT_CODEX_RS_DIR"
TOOLCHAIN_FILE=""
DEFAULT_WASI_SDK_DIR="${WASI_SDK_DIR:-$ROOT_DIR/../../tools/wasi-sdk-32.0-x86_64-linux}"
WASI_SDK_DIR="$DEFAULT_WASI_SDK_DIR"
PROFILE="debug"
CARGO_ARGS=()
DEST_WASM_PATH="$ROOT_DIR/vendor/apply_patch.wasm"

usage() {
  cat <<'EOF'
Rebuild vendor/apply_patch.wasm for pi-codex-apply-patch-wasm.

Usage:
  scripts/rebuild-codex-apply-patch-wasm.sh [--release] [--codex-rs-dir PATH] [--wasi-sdk-dir PATH]

Options:
  --release            Build release instead of debug.
  --codex-rs-dir PATH  Path to a codex/codex-rs checkout containing the codex-apply-patch crate.
  --wasi-sdk-dir PATH  Path to the local wasi-sdk directory.
  -h, --help           Show this help.

Environment:
  CODEX_RS_DIR   Default path for --codex-rs-dir.
  WASI_SDK_DIR   Default path for --wasi-sdk-dir.

Notes:
  This package does not vendor codex-rs sources. Point the script at an existing
  codex/codex-rs checkout, then it will rebuild the WASM binary and copy it into
  vendor/apply_patch.wasm.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --release)
      PROFILE="release"
      CARGO_ARGS+=(--release)
      shift
      ;;
    --codex-rs-dir)
      [[ $# -ge 2 ]] || {
        echo "Missing value for --codex-rs-dir" >&2
        exit 2
      }
      CODEX_RS_DIR="$2"
      shift 2
      ;;
    --wasi-sdk-dir)
      [[ $# -ge 2 ]] || {
        echo "Missing value for --wasi-sdk-dir" >&2
        exit 2
      }
      WASI_SDK_DIR="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

CODEX_RS_DIR="$(cd "$CODEX_RS_DIR" && pwd)"
TOOLCHAIN_FILE="$CODEX_RS_DIR/rust-toolchain.toml"

if [[ ! -d "$CODEX_RS_DIR" ]]; then
  echo "codex-rs workspace not found at $CODEX_RS_DIR" >&2
  exit 1
fi

if [[ ! -f "$TOOLCHAIN_FILE" ]]; then
  echo "rust-toolchain.toml not found at $TOOLCHAIN_FILE" >&2
  exit 1
fi

if [[ ! -d "$WASI_SDK_DIR" ]]; then
  echo "wasi-sdk not found at $WASI_SDK_DIR" >&2
  echo "Set WASI_SDK_DIR or pass --wasi-sdk-dir." >&2
  exit 1
fi

if ! command -v python >/dev/null 2>&1; then
  echo "python is required to read $TOOLCHAIN_FILE" >&2
  exit 1
fi

if ! command -v rustup >/dev/null 2>&1; then
  echo "rustup is required to install/use the pinned Rust toolchain" >&2
  exit 1
fi

TOOLCHAIN="$(python - <<'PY' "$TOOLCHAIN_FILE"
import pathlib
import re
import sys
text = pathlib.Path(sys.argv[1]).read_text()
match = re.search(r'^channel\s*=\s*"([^"]+)"', text, re.M)
if not match:
    raise SystemExit('Could not find toolchain channel in rust-toolchain.toml')
print(match.group(1))
PY
)"

export WASI_SDK_PATH="$WASI_SDK_DIR"
export WASI_SYSROOT="$WASI_SDK_DIR/share/wasi-sysroot"
export CC_wasm32_wasip1="$WASI_SDK_DIR/bin/clang"
export AR_wasm32_wasip1="$WASI_SDK_DIR/bin/llvm-ar"
export CFLAGS_wasm32_wasip1="--sysroot=$WASI_SYSROOT"

if [[ ! -x "$CC_wasm32_wasip1" ]]; then
  echo "clang not found at $CC_wasm32_wasip1" >&2
  exit 1
fi

if [[ ! -x "$AR_wasm32_wasip1" ]]; then
  echo "llvm-ar not found at $AR_wasm32_wasip1" >&2
  exit 1
fi

if [[ ! -d "$WASI_SYSROOT" ]]; then
  echo "WASI sysroot not found at $WASI_SYSROOT" >&2
  exit 1
fi

echo "Using Rust toolchain: $TOOLCHAIN"
echo "Using codex-rs dir:    $CODEX_RS_DIR"
echo "Using WASI SDK:       $WASI_SDK_DIR"
echo "Build profile:        $PROFILE"

rustup +"$TOOLCHAIN" target add wasm32-wasip1 >/dev/null

(
  cd "$CODEX_RS_DIR"
  cargo +"$TOOLCHAIN" build -p codex-apply-patch --target wasm32-wasip1 "${CARGO_ARGS[@]}"
)

WASM_PATH="$CODEX_RS_DIR/target/wasm32-wasip1/$PROFILE/apply_patch.wasm"
if [[ ! -f "$WASM_PATH" ]]; then
  echo "Build completed but output was not found at $WASM_PATH" >&2
  exit 1
fi

mkdir -p "$(dirname "$DEST_WASM_PATH")"
cp "$WASM_PATH" "$DEST_WASM_PATH"

echo
echo "Copied rebuilt wasm to:"
echo "  $DEST_WASM_PATH"
