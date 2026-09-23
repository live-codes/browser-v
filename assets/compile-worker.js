/*
 * Runs the whole pipeline off the page's thread:
 *
 *   your V  ->  v.wasm (the V compiler)  ->  main.c  ->  Clang/LLD in wasm  ->  run
 *
 * Both the compiler and the toolchain block whichever thread hosts them and take
 * seconds, so they live here; the page stays responsive and a stuck compile can be
 * cancelled by discarding the worker.
 *
 * Protocol: post { type: 'compile', source }; receive
 *   { type: 'ready' }                                 the compiler is loaded
 *   { type: 'status', text }                          what is happening now
 *   { type: 'result', output, exitCode, log }         the program ran
 *   { type: 'v-failed', log }                         V reported an error
 *   { type: 'c-failed', diagnostics, log }            the C would not build
 */
importScripts('v.js');
importScripts('v-clang-shims.js');
importScripts('clang/clang-wasm-toolchain.global.js');

// The Clang runtime tests `x instanceof SharedArrayBuffer` unconditionally and
// there is none on a page that is not cross-origin isolated. Its compile path
// never allocates one, so a stub is enough - and it keeps COOP/COEP off the page.
globalThis.SharedArrayBuffer ??= class SharedArrayBuffer {};

const decoder = new TextDecoder();
const ANSI = /\u001b\[[0-9;]*m/g;

function extractTar(bytes, FS, base) {
  const readString = (start, length) => {
    let end = start;
    while (end < start + length && bytes[end] !== 0) end++;
    return decoder.decode(bytes.subarray(start, end));
  };

  const files = [];
  let offset = 0;
  while (offset + 512 <= bytes.length) {
    const empty = bytes.subarray(offset, offset + 512).every((byte) => byte === 0);
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

let log = '';
let compilerPromise = null;
let toolchainPromise = null;

const stripAnsi = (line) => line.replace(ANSI, '');

function getCompiler() {
  if (compilerPromise) return compilerPromise;
  compilerPromise = (async () => {
    const vlib = await fetch('vlib.tar').then((response) => {
      if (!response.ok) throw new Error(`vlib.tar: HTTP ${response.status}`);
      return response.arrayBuffer();
    });

    const compiler = await self.createVCompiler({
      locateFile: (path) => new URL(path, self.location.href).href,
      print: (line) => {
        log += stripAnsi(line) + '\n';
      },
      printErr: (line) => {
        log += stripAnsi(line) + '\n';
      },
    });

    const FS = compiler.FS;
    FS.mkdirTree('/v');
    extractTar(new Uint8Array(vlib), FS, '/v/');
    FS.mkdirTree('/tmp');
    return compiler;
  })();
  return compilerPromise;
}

function getToolchain() {
  if (toolchainPromise) return toolchainPromise;
  toolchainPromise = (async () => {
    const api = self.clangWasmToolchain;
    if (!api) throw new Error('clangWasmToolchain is missing - did the bundle load?');

    const toolchain = await api.createToolchain({
      baseUrl: new URL('clang/', self.location.href),
    });

    const shims = globalThis.LiveCodesVClang.SHIMS;
    for (const path of Object.keys(shims)) {
      toolchain.addFile(path, shims[path]);
    }
    return toolchain;
  })();
  return toolchainPromise;
}

// V 0.5.2 has no native wasm code generator, so the browser-capable target is C
// for wasm32_emscripten, and -gc none avoids the Boehm GC the target otherwise
// asks for (there is no <gc.h> here). -no-parallel is what the build's synchronous
// thread stubs rely on, and -new-compiler is what makes V show its own
// diagnostics instead of quietly handing the compile to a second compiler.
async function toC(source) {
  const compiler = await getCompiler();
  const FS = compiler.FS;
  log = '';

  FS.writeFile('/main.v', source);
  try {
    FS.unlink('/main.c');
  } catch {
    /* nothing to remove yet */
  }

  const exitCode = compiler.callMain([
    '-new-compiler',
    '-b',
    'c',
    '-os',
    'wasm32_emscripten',
    '-no-parallel',
    '-gc',
    'none',
    '-o',
    '/main.c',
    '/main.v',
  ]);

  let cSource = '';
  try {
    cSource = decoder.decode(FS.readFile('/main.c'));
  } catch {
    cSource = '';
  }
  if (exitCode !== 0 || !cSource) return null;
  return cSource;
}

// V's generated C includes a few of its own files by absolute path, because the
// compiler was built with its root at /v - the same path this compiler unpacks
// vlib to. The toolchain's filesystem is a different one, so those files are
// copied across from the compiler's, which already has them. Follows nested
// includes: a header copied in can name another.
async function mountAbsoluteIncludes(cSource) {
  const compiler = await getCompiler();
  const toolchain = await getToolchain();
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

  scan(cSource);
  while (queue.length > 0) {
    const absolute = queue.shift();
    let bytes;
    try {
      bytes = compiler.FS.readFile(absolute);
    } catch {
      continue;
    }
    const text = decoder.decode(bytes);
    // memfs paths are relative to its root, so drop the leading slash.
    toolchain.addFile(absolute.replace(/^\//, ''), text);
    scan(text);
  }
}

async function buildAndRun(cSource) {
  const api = self.clangWasmToolchain;
  const toolchain = await getToolchain();
  const shims = globalThis.LiveCodesVClang;

  await mountAbsoluteIncludes(cSource);

  const compiled = await toolchain.captureCompilerOutput(() =>
    toolchain.runtime.compileArtifact(shims.SOURCE_PATCHES + cSource, {
      language: 'C',
      fileName: 'main.c',
      compileArgs: [...(api.CLANG_DRIVER_DEFAULT_ARGS ?? []), ...shims.COMPILE_ARGS],
    }),
  );

  if (compiled.error) {
    const diagnostics = (api.compilerDiagnostics ?? ((raw) => String(raw).split('\n')))(
      compiled.raw,
    );
    return { ok: false, diagnostics };
  }

  const chunks = [];
  const result = await toolchain.execute(compiled.result, {
    args: [],
    stdin: '',
    stdout: (chunk) => chunks.push(chunk),
    stderr: (chunk) => chunks.push(chunk),
  });
  return { ok: true, output: chunks.join(''), exitCode: result.exitCode };
}

self.addEventListener('message', async (event) => {
  const { type, source } = event.data || {};
  if (type !== 'compile') return;

  try {
    const cSource = await toC(source);
    if (cSource === null) {
      self.postMessage({ type: 'v-failed', log });
      return;
    }

    if (!toolchainPromise) {
      self.postMessage({ type: 'status', text: 'Loading the C→wasm toolchain…' });
    }
    const built = await buildAndRun(cSource);

    if (!built.ok) {
      self.postMessage({ type: 'c-failed', diagnostics: built.diagnostics });
      return;
    }
    self.postMessage({ type: 'result', output: built.output, exitCode: built.exitCode, log });
  } catch (error) {
    self.postMessage({ type: 'v-failed', log, error: String(error?.stack || error) });
  }
});

getCompiler()
  .then(() => self.postMessage({ type: 'ready' }))
  .catch((error) => self.postMessage({ type: 'v-failed', error: String(error?.stack || error) }));
