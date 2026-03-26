import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { stdin, argv, env, exit } from 'node:process';
import { WASI } from 'node:wasi';

async function readStdin() {
  const chunks = [];
  for await (const chunk of stdin) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function fail(message, code = 1) {
  console.error(message);
  exit(code);
}

const cwdArg = argv[2];
const wasmArg = argv[3];

if (!cwdArg || !wasmArg) {
  fail('Usage: node runner.mjs <cwd> <wasmPath> < patch.txt', 2);
}

const cwd = path.resolve(cwdArg);
const wasmPath = path.resolve(wasmArg);

if (!existsSync(cwd)) {
  fail(`Working directory does not exist: ${cwd}`);
}
if (!statSync(cwd).isDirectory()) {
  fail(`Working directory is not a directory: ${cwd}`);
}
if (!existsSync(wasmPath)) {
  fail(`Wasm binary does not exist: ${wasmPath}`);
}

const patch = await readStdin();

try {
  const wasi = new WASI({
    version: 'preview1',
    args: ['apply_patch', patch],
    env,
    preopens: { '.': cwd },
    returnOnExit: true,
  });

  const wasm = readFileSync(wasmPath);
  const { instance } = await WebAssembly.instantiate(wasm, {
    wasi_snapshot_preview1: wasi.wasiImport,
  });

  const exitCode = wasi.start(instance);
  exit(typeof exitCode === 'number' ? exitCode : 0);
} catch (error) {
  const message = error instanceof Error ? error.stack || error.message : String(error);
  fail(`Failed to execute apply_patch.wasm: ${message}`);
}
