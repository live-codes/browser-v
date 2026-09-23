// Dev harness: build and run C that the V compiler generated, from Node, using the
// same shims and the same steps the page's worker uses. Nothing here ships.
//
//   node dev-run.mjs <main.c> [stdin]
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createToolchain,
  compilerDiagnostics,
  CLANG_DRIVER_DEFAULT_ARGS,
} from '@live-codes/clang-wasm/toolchain';

const here = dirname(fileURLToPath(import.meta.url));
const assets = join(here, '..', 'assets');

// The shim list is shared with the page's worker rather than duplicated. The file
// is a plain script that sets a global, so evaluating it is enough.
new Function(readFileSync(join(assets, 'v-clang-shims.js'), 'utf8'))();
const { SHIMS, SOURCE_PATCHES, COMPILE_ARGS } = globalThis.LiveCodesVClang;

const vlibTar = readFileSync(join(assets, 'vlib.tar'));

// V's generated C includes a few of its own files by absolute path ("/v/vlib/...").
// The vlib tarball is the same tree, so the driver reads them out of it.
function readVlibFile(absolutePath) {
  const name = absolutePath.replace(/^\//, '');
  const readString = (start, length) => {
    let end = start;
    while (end < start + length && vlibTar[end] !== 0) end++;
    return vlibTar.toString('utf8', start, end);
  };

  let offset = 0;
  while (offset + 512 <= vlibTar.length) {
    if (vlibTar.subarray(offset, offset + 512).every((byte) => byte === 0)) break;
    const prefix = readString(offset + 345, 155);
    const entry = prefix ? `${prefix}/${readString(offset, 100)}` : readString(offset, 100);
    const size = Number.parseInt(readString(offset + 124, 12).trim(), 8) || 0;
    const dataStart = offset + 512;
    if (entry === name) return vlibTar.toString('utf8', dataStart, dataStart + size);
    offset = dataStart + Math.ceil(size / 512) * 512;
  }
  return null;
}

function mountAbsoluteIncludes(code, toolchain) {
  const seen = new Set();
  const queue = [];
  const scan = (text) => {
    const pattern = /#include\s+"(\/[^"]+)"/g;
    let match;
    while ((match = pattern.exec(text)) !== null) {
      if (!seen.has(match[1])) {
        seen.add(match[1]);
        queue.push(match[1]);
      }
    }
  };

  scan(code);
  let mounted = 0;
  while (queue.length > 0) {
    const absolute = queue.shift();
    // The C says "/v/vlib/...", because the compiler's root is /v; the tarball
    // stores the same tree without that prefix.
    const text = readVlibFile(absolute.replace(/^\/v\//, '/'));
    if (text === null) continue;
    // The toolchain's memfs keeps it where the absolute include will find it.
    toolchain.addFile(absolute.replace(/^\//, ''), text);
    mounted += 1;
    scan(text);
  }
  return mounted;
}

const file = process.argv[2];
const stdin = process.argv[3] ?? '';
const code = readFileSync(file, 'utf8');
console.log(`# source: ${file} (${code.length} bytes)`);

const started = Date.now();
const toolchain = await createToolchain();
const { runtime } = toolchain;
console.log(`# toolchain ready in ${Date.now() - started} ms (${toolchain.assetSource})`);

for (const path of Object.keys(SHIMS)) {
  toolchain.addFile(path, SHIMS[path]);
}
console.log(`# shims mounted: ${Object.keys(SHIMS).length}`);
console.log(`# absolute includes mounted from vlib.tar: ${mountAbsoluteIncludes(code, toolchain)}`);

const compiled = await toolchain.captureCompilerOutput(() =>
  runtime.compileArtifact(SOURCE_PATCHES + code, {
    // The runtime spells its modes 'C', 'CPP', 'objective-c'... - not 'c'.
    language: 'C',
    fileName: 'main.c',
    compileArgs: [...CLANG_DRIVER_DEFAULT_ARGS, ...COMPILE_ARGS],
  }),
);

if (compiled.error) {
  console.log('# build failed');
  for (const line of compilerDiagnostics(compiled.raw)) console.log(`#   ${line}`);
  process.exit(1);
}

const chunks = [];
const result = await toolchain.execute(compiled.result, {
  args: [],
  stdin,
  stdout: (chunk) => chunks.push(chunk),
  stderr: (chunk) => chunks.push(chunk),
});

console.log(`# exitCode: ${result.exitCode}`);
console.log('# program output:');
console.log(chunks.join(''));
