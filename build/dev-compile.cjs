'use strict';
/*
 * Dev harness: drive the built V compiler from Node, at native speed.
 *
 *   node dev-compile.cjs <assetsDir> <sourceFile> [v args...]
 *
 * The browser is a poor debugger for a compiler that blocks its thread, so this
 * runs the very same v.js/v.wasm straight from the command line, with V's own
 * output going to stdout. Nothing here ships.
 */
const path = require('node:path');
const fs = require('node:fs');
const zlib = require('node:zlib');

const assetsDir = path.resolve(process.argv[2]);
const sourceFile = process.argv[3] ? path.resolve(process.argv[3]) : null;
const vArgs = process.argv.slice(4);

const cachePath = path.join(__dirname, 'v-compiler.cjs');
fs.copyFileSync(path.join(assetsDir, 'v.js'), cachePath);
const createVCompiler = require(cachePath);

const decoder = new TextDecoder();

function extractTar(bytes, FS, base) {
  const readString = (start, length) => {
    let end = start;
    while (end < start + length && bytes[end] !== 0) end++;
    return decoder.decode(bytes.subarray(start, end));
  };
  const files = [];
  let offset = 0;
  while (offset + 512 <= bytes.length) {
    const empty = bytes.subarray(offset, offset + 512).every((b) => b === 0);
    if (empty) break;
    const prefix = readString(offset + 345, 155);
    const name = readString(offset, 100);
    const pathName = (prefix ? prefix + '/' + name : name).replace(/^\/+/, '');
    const size = Number.parseInt(readString(offset + 124, 12).trim(), 8) || 0;
    const type = bytes[offset + 156] === 0 ? '0' : String.fromCharCode(bytes[offset + 156]);
    const dataStart = offset + 512;
    const target = base + pathName;
    if (type === '5') {
      FS.mkdirTree(target);
    } else if (type === '0') {
      files.push([target, bytes.subarray(dataStart, dataStart + size)]);
    }
    offset = dataStart + Math.ceil(size / 512) * 512;
  }
  for (const [target, data] of files) {
    const dir = target.slice(0, target.lastIndexOf('/'));
    if (dir) FS.mkdirTree(dir);
    FS.writeFile(target, data);
  }
}

const SOURCE =
  sourceFile ?
    fs.readFileSync(sourceFile, 'utf8')
  : "fn main() {\n\tprintln('hi')\n}\n";

(async () => {
  const t0 = Date.now();
  // Shipped gzipped; the package inflates it, so the harness does too.
  const wasmBytes = zlib.gunzipSync(fs.readFileSync(path.join(assetsDir, 'v.wasm.gz')));
  const wasmModule = new WebAssembly.Module(wasmBytes);
  let stdoutBuf = '';
  const compiler = await createVCompiler({
    locateFile: (p) => path.join(assetsDir, p),
    // Node has no fetch for file paths, so instantiate from the bytes we read.
    instantiateWasm: (imports, success) => {
      const instance = new WebAssembly.Instance(wasmModule, imports);
      success(instance, wasmModule);
      return instance.exports;
    },
    print: (line) => {
      stdoutBuf += line + '\n';
    },
    printErr: (line) => process.stderr.write(`[v!] ${line}\n`),
    ENV: { V_MACOS_V3_NO_FALLBACK: '1' },
  });
  console.log(`# compiler ready in ${Date.now() - t0} ms`);

  const FS = compiler.FS;
  FS.mkdirTree('/v');
  const t1 = Date.now();
  extractTar(new Uint8Array(zlib.gunzipSync(fs.readFileSync(path.join(assetsDir, 'vlib.tar.gz')))), FS, '/v/');
  FS.mkdirTree('/tmp');
  console.log(`# vlib unpacked in ${Date.now() - t1} ms`);

  FS.writeFile('/main.v', SOURCE);

  const args = vArgs.length > 0 ? vArgs : ['-new-compiler', '-b', 'c', '-os', 'wasm32_emscripten', '-no-parallel', '-gc', 'none', '-o', '/main.c', '/main.v'];
  console.log(`# callMain ${JSON.stringify(args)}`);
  const t2 = Date.now();
  const code = compiler.callMain(args);
  console.log(`# exit=${code} after ${Date.now() - t2} ms`);
  console.log(`# stdout: ${stdoutBuf.length} bytes`);
  console.log(`#   as text: ${JSON.stringify(stdoutBuf.slice(0, 160))}`);

  for (const p of ['/main.c', '/main.wasm']) {
    try {
      const bytes = FS.readFile(p);
      const text = FS.readFile(p, { encoding: 'utf8' });
      console.log(`# ${p}: ${bytes.length} bytes (utf8 read: ${text.length})`);
      console.log(`#   first bytes: [${Array.from(bytes.slice(0, 24)).join(',')}]`);
      console.log(`#   as text: ${JSON.stringify(decoder.decode(bytes.slice(0, 120)))}`);
    } catch {
      console.log(`# ${p}: not produced`);
    }
  }

  if (process.env.DUMP_C) {
    try {
      fs.writeFileSync(process.env.DUMP_C, FS.readFile('/main.c'));
      console.log(`# wrote generated C to ${process.env.DUMP_C}`);
    } catch (error) {
      console.log(`# could not dump C: ${error}`);
    }
  }

  // For -b wasm, where the module is the output rather than the C. See dev-run-vwasm.mjs.
  if (process.env.DUMP_WASM) {
    try {
      fs.writeFileSync(process.env.DUMP_WASM, FS.readFile('/main.wasm'));
      console.log(`# wrote generated wasm to ${process.env.DUMP_WASM}`);
    } catch (error) {
      console.log(`# could not dump wasm: ${error}`);
    }
  }

  console.log('# filesystem root:');
  for (const name of FS.readdir('/')) {
    if (name === '.' || name === '..') continue;
    try {
      const st = FS.stat('/' + name);
      if (FS.isDir(st.mode)) {
        console.log(`#   /${name} <dir>`);
        continue;
      }
      const bytes = FS.readFile('/' + name);
      const preview = decoder.decode(bytes.slice(0, 120)).replace(/\n/g, '\\n');
      console.log(`#   /${name} ${st.size} bytes :: ${JSON.stringify(preview.slice(0, 100))}`);
    } catch {
      console.log(`#   /${name} ?`);
    }
  }
})().catch((error) => {
  console.error('# harness error:', error);
  process.exit(1);
});
