# browser-v

Proof of concept: **compile and run V (vlang) in the browser, with no server.**

The V compiler itself — compiled to WebAssembly — runs on the page. A program is typed in,
compiled entirely client-side, and executed in the same page. Nothing is sent anywhere; there
is no compilation backend.

```bash
npm start        # http://localhost:4180
```

`npm start` is a plain static file server (Node, no dependencies). It exists only because the
page fetches its `.wasm` assets and uses ES modules, which browsers require a real origin for.
It is not a compilation server, and it serves nothing but static files.

![The playground after running the first sample](docs/screenshot.png)

## How it works

```
            ┌──────────────────────────── the page ────────────────────────────┐
your V code │  /main.v                                                          │
     ──────▶│  v.wasm  (the V compiler, WASI)  ──▶  /main.js                    │
            │        ▲                                │                         │
            │        │  WASI shim + WasmFs (in-memory filesystem)               │
            │        │  /vlib  (the V standard library)                        │
            │        ▼                                ▼                         │
            │  v -b js -nocolor main.v           new Function(...)(main.js)     │
            └───────────────────────────────────────────────────────────────────┘
```

1. `assets/v.wasm` is the **V compiler**, built to a WASI WebAssembly module, and
   `assets/vlib.tar` is the V standard library it compiles against.
2. On each run a fresh in-memory filesystem (`WasmFs`) is created. The standard library is
   unpacked into `/vlib`, and the submitted source is written to `/main.v`.
3. The compiler is instantiated with a JS WASI shim and invoked as
   `v -b js -nocolor main.v`, which emits JavaScript at `/main.js`.
4. The emitted JavaScript is executed in the page, with `console` and `process` supplied as
   the host API. V's JavaScript backend targets Node, so its `print`/`eprint`/`exit` map to
   `process.stdout`/`process.stderr`/`process.exit`; those are shimmed to the output pane.

Everything above the `WebAssembly.instantiate` line runs on the page — the compiler is a real
compiler (lexer, parser, checker, code generator), not a subset or an interpreter.

## Files

| File | Purpose |
| --- | --- |
| `index.html` | The whole playground: editor, the compiler/WASI pipeline, the run and stop controls. The interesting part is the module script at the bottom. |
| `assets/v.wasm` | The V compiler, compiled to WASI WebAssembly (1.4 MB). |
| `assets/vlib.tar` | The V standard library the compiler compiles against (270 KB). |
| `serve.mjs` | A dependency-free static file server, for local use. |
| `docs/screenshot.png` | Screenshot of the running page. |

There are no npm dependencies. The page pulls its WASI runtime (`@wasmer/wasi`, `@wasmer/wasmfs`,
`@wasmer/wasm-transformer`) and a `path` shim (`@jspm/core`) from `jspm.dev` / `unpkg.com` at
load time — those are ES-module CDN dependencies, not a compilation service, and nothing about
the submitted code leaves the machine.

## What works

Verified end to end in headless Chromium:

- Hello world, recursion, `for`-range loops, string interpolation (`${...}`), `FizzBuzz`.
- `print` and `println` (and their `e` variants), each routed to the output pane.
- Structs with `mut` fields and methods.
- Real compiler diagnostics — a syntax error shows V's own message with the source line and a
  caret, e.g. `main.v:1:15: error: unexpected 'eof', expecting ','`.

## Limitations (this is a proof of concept)

- **The JavaScript backend only.** Compilation uses `v -b js`, which emits JavaScript. The
  native `-b wasm` backend is a different route and would need a WASI/custom-JS runtime for the
  produced module; it is not wired up here.
- **The compiler is old and third-party.** The bundled `v.wasm` emits
  `V_CURRENT_COMMIT_HASH e77c4c1` and predates the 2023 rewrite of the WASM backend. It is a
  prebuilt taken from the `v-wasm.vercel.app` playground (see provenance below), not something
  this repo builds.
- **The main thread blocks while compiling.** The compiler runs synchronously on the page, so
  the UI freezes for the length of a compile. A worker would fix this (see next steps). The
  *program* must stay on the page — it needs a document — which is why the run step is not in a
  worker.
- **Feature coverage is whatever that V version supports.** No C interop, no filesystem for the
  compiled program (the module gets a WASI environment with no preopened directories), no
  stdin/argv wiring beyond the placeholder `argv`.
- **Network dependency for the runtime shims.** The page needs `jspm.dev` / `unpkg.com` to
  reach the WASI runtime modules. Vendoring those is a packaging step, not a rewrite.

## Provenance and licensing

- `assets/v.wasm`, `assets/vlib.tar` — from the **V WASM Playground** by Zamfofex
  (originally `github.com/zamfofex/v-wasm`, since removed; the deployed `v-wasm.vercel.app`
  still serves them). They are a build of the V compiler and parts of its standard library.
  **V is MIT-licensed**, but these particular bytes are a third-party prebuilt whose build
  recipe is not published — treat the pin as provisional and replace it with an in-house build
  before this ships anywhere real. `v.wasm` and `vlib.tar` are committed here so the PoC runs
  with no setup; they are ~1.7 MB total.
- Everything else is MIT.

## Findings

Things that had to be worked out, worth carrying forward:

- **`v -b js` is the pragmatic no-server target.** It needs no C compiler and no Clang
  toolchain — just the V compiler. This is why the PoC is small (~1.7 MB) where a C-backend
  route (`clang` + `lld` + a sysroot) would be tens of megabytes.
- **i64 imports need lowering.** The compiler module imports 64-bit WASI functions the JS
  shim cannot satisfy directly, so the module is transformed with
  `@wasmer/wasm-transformer`'s `lowerI64Imports` before `WebAssembly.compile`.
- **The compiler finds `vlib` relative to its own executable path.** It is placed at `/v` with
  `/proc/self/exe` symlinked to `/v`, so it looks for `/vlib`, which is where the tarball is
  unpacked.
- **A hand-rolled tar reader beats the `tar` package.** The npm `tar` module drags in Node
  shims and dies in the browser (`process.binding is not supported by JSPM core`). The archive
  only contains plain files and directories (checked: typeflags `0` and `5`, longest name 49
  characters), so `extractTar` in `index.html` unpacks it directly into `WasmFs` in ~35 lines
  with no dependency.
- **`println` works but `print` does not, out of the box.** V's JS backend emits
  `console.log` for `println` but `process.stdout.write` for `print` — so a `process` shim is
  required, or every `print` (no newline) throws `process is not defined`.

## Next steps toward LiveCodes

1. **Build `v.wasm` in-house** and pin it, instead of depending on an unbuildable third-party
   binary. That is the same work `browser-nim` documents for its Nim compiler.
2. **Move compilation into a Web Worker.** The compiler is synchronous; a worker keeps the page
   responsive and makes the Stop button able to cancel a runaway compile. The generated program
   still runs on the page.
3. **Wire it into LiveCodes as a `v` language** following the `-b js` model: a pass-through
   compiler plus a result-page runtime script that runs the emitted JavaScript, in the same
   shape as the existing `nim` (JavaScript backend) support. A second `v-wasm` language using
   the native `-b wasm` backend plus a WASI shim is a possible follow-up, mirroring the
   `nim` / `nim-wasm` split.
