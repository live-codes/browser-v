# @live-codes/v-wasm

Run **V (vlang)** in the browser, on the V compiler compiled to WebAssembly. No server and no native
toolchain: the compiler runs in the page, and the C it emits is compiled and linked by the same Clang 22
toolchain [`@live-codes/clang-wasm`](https://www.npmjs.com/package/@live-codes/clang-wasm) uses for C,
C++ and Objective-C.

```js
import { createCompiler } from '@live-codes/v-wasm';

const compiler = await createCompiler();

const { stdout, errors, exitCode } = await compiler.run(`
  fn main() {
    println('Hello from V!')
  }
`);
```

In a browser there is no filesystem, so a page has to be given a URL for the compiler's assets:

```bash
npx @live-codes/v-wasm-copy-assets public/v
```

```js
const compiler = await createCompiler({
  baseUrl: new URL('/v/', location.href),
  clangBaseUrl: new URL('/clang/', location.href)
});
```

Either way the package is bundled like any other npm package, because it imports `@live-codes/clang-wasm`
by name.

## API

### `createCompiler(options)`

Returns a promise for a compiler. The compiler's assets are fetched here, so a bad `baseUrl` fails at
this point rather than at the first `run`.

| Option | Meaning |
| --- | --- |
| `target` | `'wasm'` (the default) compiles to C, links it and runs it; `'c'` stops at the generated C and hands it back as `compiledCode`, without loading the Clang toolchain. |
| `baseUrl` | Where this package's assets are served from. **Optional in Node**, where the assets that ship in the package are read off disk; required anywhere else. |
| `clangBaseUrl` | Where the Clang toolchain's assets are. Passed to `@live-codes/clang-wasm`, whose rules apply — required in a browser, optional in Node — and whose runtime is *shared* with any C/C++ compilers created against the same assets, so a page running both pays for the toolchain once or not at all. |
| `compileArgs` | Extra V flags, before the source path, e.g. `['-d', 'myflag']`. |
| `clangArgs` | Extra clang flags. |
| `args` | Default program argv. |
| `onProgress` | `(value) => {}`, 0 to 1, while the toolchain downloads. |
| `onLog` | `(text, stream) => {}` — the compilers' own output, which is where diagnostics arrive. |
| `onOutput` | `(text, stream) => {}` — the program's output as it is written. See Notes. |
| `onStatus` | `(text) => {}`, for a status line. |

`targets` (the list) and `TARGETS` are exported, so a caller can check the names rather than hard-code
them.

### `compiler.run(code, input?, runOptions?)`

| Field | Meaning |
| --- | --- |
| `stdout` / `stderr` | Everything the program wrote to each stream. |
| `output` | Both, in the order the program wrote them — what a terminal would have shown. |
| `errors` | V's, clang's and the linker's diagnostics, one string per line, colour removed. **Empty when it built**, so `errors.length` is a reliable failure test. |
| `exitCode` | The program's status, or `null` if it never ran — because the compile failed, or because the target was `c`, which never runs. |
| `compileMs` | Wall clock for the compile. For `wasm` that is V's codegen plus clang and the link; for `c` it is V's codegen alone. |
| `runMs` | Wall clock for the run, or `null` if it did not run. |
| `compiledCode` | The `c` target's artifact: the generated C, as one string. Absent otherwise. |

`input` is handed to the program as stdin once and then closed. `runOptions` may override `args`,
`compileArgs`, `clangArgs`, and `onOutput`. `compiler.assetSource` says where its assets came from, and
`compiler.target` says what was resolved.

### Taking the C away

`target: 'c'` stops at the code generation the `wasm` target would carry on from, and hands back what V
wrote instead of compiling and running it. Nothing executes, so `exitCode`, `runMs` and the output are
all empty and `compiledCode` is the whole result — the generated C, as one string:

```js
import { createCompiler } from '@live-codes/v-wasm';

const compiler = await createCompiler({ target: 'c' });
const { compiledCode } = await compiler.run(`
  fn main() {
    println('hello')
  }
`);
// '// V comptime_definitions: … int main(…) { … }'
```

Two things are worth knowing about the C:

- **It is one translation unit.** V writes a single file that `#include`s its standard library by
  absolute path (`/v/vlib/...`). To compile it yourself you need V's `vlib` tree at those paths — which
  the compiler's own filesystem holds, and which the `wasm` target resolves for you.
- **The `c` target never loads the Clang toolchain**, so it costs one V compile (a few hundred
  milliseconds warm) and none of the ~29 MB toolchain download.

### `@live-codes/v-wasm/iife`

`dist/v-wasm.global.js` is a minified IIFE for anywhere an ES module cannot go — a classic worker, a
plain `<script>`, a CDN URL handed to `importScripts()`. It sets `self.vWasm` to `createCompiler`, and
bundles the Clang toolchain with it, so it is a large single file. It is built from `src/index.js` and
carries none of the Node-only code.

The V compiler itself must be loaded in a **classic** worker, not a module worker: its Emscripten bundle
decides it is in a worker by finding `importScripts`, which module workers do not have.

## Where the assets come from

The compiler ships inside the package: `v.js`, `v.wasm.gz` (~5 MB) and the `vlib.tar.gz` standard
library (~3.2 MB). The two large assets are **shipped gzipped and inflated in JavaScript**, so the size
a host transfers does not depend on whether that host compresses anything itself. Unlike the sibling
`@live-codes/nim-wasm`, they are not a third-party prebuilt — they are built from a pinned V commit by
this repository's own container pipeline (`build/build-v-wasm.sh`, run from `build/Dockerfile`), which
also post-optimises the linked module with binaryen and records the SHA-256 of each artifact. Those
digests are what [`src/asset-receipts.js`](./src/asset-receipts.js) pins, and every read is verified
against them — a host serving different bytes fails with both digests rather than running a different
compiler.

`THIRD-PARTY-NOTICES.md` says what is whose, and [`docs/ASSETS.md`](./docs/ASSETS.md) records how the
bytes are produced and how to re-pin them.

In a browser those files have to be served, and `v-wasm-copy-assets` copies them — with a receipt file
for its own bytes — into a directory you already serve.

The other toolchain is not shipped here at all. It reaches `@live-codes/clang-wasm`, which is where its
assets and their receipts live.

## Notes

- **The compilers block the thread they run on.** Both the V compiler and the whole Clang toolchain are
  synchronous, so a build takes the calling thread for its duration — seconds. Run the package in a
  worker, as `browser-v` does, and the page stays responsive.
- **Compiles do not interleave.** Everything between clearing the compiler's output and reading its C is
  synchronous, so two `run()` calls queue behind each other rather than writing over one another. The
  Clang toolchain serialises itself for the same reason.
- **`onOutput` is a stream, and the result is the truth.** The program's output arrives chunk by chunk
  while it runs, and in full in the result when it finishes; draw the first and trust the second.
- **Memory.** Budget for the V compiler's own footprint, plus the Clang runtime's few hundred MB.

## Standard library

The full V standard library ships in `vlib.tar.gz`, and most of it works — the compiler decides what
compiles, not a hand-picked subset. Verified in the test suite: `arrays`, `strings`, `strconv`, `math`,
`math.big`, `rand`, `crypto.rand`, `crypto.sha256`, `crypto.sha512`, `crypto.md5`, `encoding.base64`,
`encoding.hex`, `encoding.csv`, `hash.crc32`, `json`, `time`, `sync`, `datatypes`, `flag` and
`benchmark`.

Two parts of the C layer are what make that work, rather than the modules themselves:

- **C11 atomics and POSIX semaphores**, which `sync`, `time` and `benchmark` reach, are supplied by the
  shims in `src/shims.js` — the Clang resource directory is pruned, and WASI has no semaphores.
- **`json` is backed by V's bundled cJSON.** The compiler emits `#include "cJSON.h"` and calls into
  cJSON, but does not embed the C; the package compiles that one file as a second translation unit
  alongside the generated C, only when a program uses it.

What does not work is what a browser cannot provide: `net` / `net.http` (sockets and mbedTLS),
`sqlite`, file and process I/O (`os` file functions, `os.execute`), and anything else needing a real C
library behind `#include` / `#flag`.

## Limitations

- **C interop is disabled.** The compiler is built with its native-input scan neutralised, which is what
  makes it start at all in the browser; a program using `#include` / `#flag` against C headers will not
  resolve them. The standard library is the exception — see above.
- **Programs are compiled `-gc none`**, so a long-running program grows memory rather than collecting.
- **`getpid()` always returns 1**, and **`pipe()` fails** — WASI has no process ids and no pipes. A
  program that calls `os.execute` cannot be given a child process.
- **The compiler is optimised for size, not speed.** The module is post-optimised with
  `wasm-opt -O2 --strip-debug`; a full `-O2` rebuild of the compiler itself is blocked by a
  self-hosting bootstrap failure in this environment (see [`docs/ASSETS.md`](./docs/ASSETS.md)).
- **The memfs is not shared** between the compiler's filesystem and the toolchain's; V's generated C
  includes a few of its own files by absolute path, and those are copied across.

## Verification

```bash
npm test    # node --test test/*.test.mjs
```

Real compiles and real runs, in Node, off the assets that ship in this package: the full pipeline end to
end, the result shape, diagnostics for a program that does not compile, streaming output, program argv
and stdin, `compileArgs`, one compiler across repeated runs, queued runs, the error a browser gets when
`baseUrl` is missing, a representative slice of the standard library (see
[Standard library](#standard-library)), and the generated C the `c` target hands back — including that
it does so without ever loading the Clang toolchain.

## Licence

**MIT**, and nothing here is copyleft, so nothing constrains the programs you compile. The compiler in
`assets/v/` is the V compiler and its standard library, also MIT; see
[THIRD-PARTY-NOTICES.md](./THIRD-PARTY-NOTICES.md).
