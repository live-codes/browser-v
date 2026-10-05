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
| `baseUrl` | Where this package's assets are served from. **Optional in Node**, where the assets that ship in the package are read off disk; required anywhere else. |
| `clangBaseUrl` | Where the Clang toolchain's assets are. Passed to `@live-codes/clang-wasm`, whose rules apply — required in a browser, optional in Node — and whose runtime is *shared* with any C/C++ compilers created against the same assets, so a page running both pays for the toolchain once or not at all. |
| `compileArgs` | Extra V flags, before the source path, e.g. `['-d', 'myflag']`. |
| `clangArgs` | Extra clang flags. |
| `args` | Default program argv. |
| `onProgress` | `(value) => {}`, 0 to 1, while the toolchain downloads. |
| `onLog` | `(text, stream) => {}` — the compilers' own output, which is where diagnostics arrive. |
| `onOutput` | `(text, stream) => {}` — the program's output as it is written. See Notes. |
| `onStatus` | `(text) => {}`, for a status line. |

### `compiler.run(code, input?, runOptions?)`

| Field | Meaning |
| --- | --- |
| `stdout` / `stderr` | Everything the program wrote to each stream. |
| `output` | Both, in the order the program wrote them — what a terminal would have shown. |
| `errors` | V's, clang's and the linker's diagnostics, one string per line, colour removed. **Empty when it built**, so `errors.length` is a reliable failure test. |
| `exitCode` | The program's status, or `null` if it never ran because the compile failed. |
| `compileMs` | Wall clock for the whole build — V's codegen plus clang and the link, which is what a caller is actually waiting for. |
| `runMs` | Wall clock for the run, or `null` if it did not run. |

`input` is handed to the program as stdin once and then closed. `runOptions` may override `args`,
`compileArgs`, `clangArgs`, and `onOutput`. `compiler.assetSource` says where its assets came from.

### `@live-codes/v-wasm/iife`

`dist/v-wasm.global.js` is a minified IIFE for anywhere an ES module cannot go — a classic worker, a
plain `<script>`, a CDN URL handed to `importScripts()`. It sets `self.vWasm` to `createCompiler`, and
bundles the Clang toolchain with it, so it is a large single file. It is built from `src/index.js` and
carries none of the Node-only code.

The V compiler itself must be loaded in a **classic** worker, not a module worker: its Emscripten bundle
decides it is in a worker by finding `importScripts`, which module workers do not have.

## Where the assets come from

The compiler ships inside the package: `v.js`, ~17 MB of `v.wasm`, and the ~14 MB `vlib.tar` standard
library. Unlike the sibling `@live-codes/nim-wasm`, they are not a third-party prebuilt — they are built
from a pinned V commit by this repository's own container pipeline (`build/build-v-wasm.sh`, run from
`build/Dockerfile`), and the build records the SHA-256 of each artifact. Those digests are what
[`src/asset-receipts.js`](./src/asset-receipts.js) pins, and `vlib.tar` (and, in Node, everything) is
verified against them on every read — a host serving different bytes fails with both digests rather than
running a different compiler.

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

## Limitations

- **C interop is disabled.** The compiler is built with its native-input scan neutralised, which is what
  makes it start at all in the browser; a program using `#include` / `#flag` against C headers will not
  resolve them.
- **Programs are compiled `-gc none`**, so a long-running program grows memory rather than collecting.
- **`getpid()` always returns 1**, and **`pipe()` fails** — WASI has no process ids and no pipes. A
  program that calls `os.execute` cannot be given a child process.
- **`v.wasm` is unoptimised** — it is built `-O0`, which is the most obvious thing to improve.
- **The memfs is not shared** between the compiler's filesystem and the toolchain's; V's generated C
  includes a few of its own files by absolute path, and those are copied across.

## Verification

```bash
npm test    # node --test test/*.test.mjs
```

Real compiles and real runs, in Node, off the assets that ship in this package: the full pipeline end to
end, the result shape, diagnostics for a program that does not compile, streaming output, program argv
and stdin, `compileArgs`, one compiler across repeated runs, queued runs, and the error a browser gets
when `baseUrl` is missing.

## Licence

**MIT**, and nothing here is copyleft, so nothing constrains the programs you compile. The compiler in
`assets/v/` is the V compiler and its standard library, also MIT; see
[THIRD-PARTY-NOTICES.md](./THIRD-PARTY-NOTICES.md).
