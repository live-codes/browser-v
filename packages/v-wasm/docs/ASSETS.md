# The compiler assets: where they come from, and how to move them

`assets/v/` holds the V compiler, compiled to WebAssembly. Unlike the sibling `@live-codes/nim-wasm`, it
is **not** a third-party prebuilt: it is built from a pinned V commit by this repository's own container
pipeline. This file records what the files are, how they are produced, and what to do when they need to
be replaced.

## What the three files are

| File | Size | What it is |
| --- | --- | --- |
| `v.js` | 157 KB | The Emscripten loader for the compiler |
| `v.wasm` | 17.2 MB | The V 0.5.2 compiler, compiled from C to wasm32_emscripten |
| `vlib.tar` | 14.1 MB | The V standard library the compiler compiles against, pruned and packed |

The first two are a matched pair: `v.js` loads `v.wasm` through `Module.locateFile` (a browser, by URL)
or `Module.instantiateWasm` (Node, from these bytes). Replacing one without the other will not work.
`vlib.tar` is unpacked into the compiler's memory filesystem at `/v`, and the generated C includes its
files by that absolute path.

## Where they come from

- **The language**: V **0.5.2**, MIT, at commit `e1ec613778753bfe9cd35f9178d472a9def890bf`.
  <https://github.com/vlang/v>
- **The build**: [`build/build-v-wasm.sh`](../../../build/build-v-wasm.sh), run inside
  [`build/Dockerfile`](../../../build/Dockerfile) by `npm run build:assets` at the repository root.

The exact bytes are pinned by size and SHA-256 in [`src/asset-receipts.js`](../src/asset-receipts.js),
along with that provenance, and **`vlib.tar` is verified against the pin on every read** (and every asset
in Node). A host serving something else fails with both digests rather than running a different compiler.

## How they are built

Everything is in `build/build-v-wasm.sh`; the summary is:

1. Fetch V at the pinned commit and patch it. Each patch exists because the wasm build has no C
   toolchain and no threads, and V's compiler assumes both: a `wasm32_emscripten` branch for
   `os.user_os()`, the native-input scan neutralised (there is no C compiler to query), the C output
   writer forced to sequential (`Emscripten`'s `mmap` of a memory file does not write back), and
   synchronous `pthread`/`semaphore` stubs linked in with `-Wl,--wrap` (`build/v-wasm-stubs.c`).
2. Bootstrap a native V, build a native V3 from the pinned sources, and generate C for the compiler with
   `-os wasm32_emscripten`.
3. Compile that C to `v.js` + `v.wasm` with `emcc` (currently `-O0`; see the known limitation about
   optimisation).
4. Pack the standard library into `vlib.tar`, pruned of test files, docs and the compiler's own `vlib/v`
   tree (which is already compiled into `v.wasm`), with the few files read at run time added back.
5. Write `receipt.json` with the V commit, the emcc version and the SHA-256 of every artifact.

The `v.wasm` this produces is unoptimised, and that is the largest obvious improvement available: it is
downloaded on every page load.

## How to move the pin

Replacing the assets is deliberate, and it is the build that moves it:

```bash
npm run build:assets       # docker build --output type=local,dest=./assets build
```

That writes `assets/v.js`, `assets/v.wasm`, `assets/vlib.tar` and `assets/receipt.json` at the
repository root. To carry a new build into the package:

1. Copy the three artifacts into `packages/v-wasm/assets/v/`.
2. Take the SHA-256s from the new `receipt.json` (or compute them) and paste them into
   `packages/v-wasm/src/asset-receipts.js`, updating `ASSET_SOURCE` alongside them - the V commit, and
   the compiler version if that changed too. A pin without its provenance is only half the record.
3. Rebuild the IIFE bundle (`npm run build:iife` in this package). The receipts are bundled into
   `dist/v-wasm.global.js`, so it carries the old pin until it is rebuilt.
4. Run the tests - `npm test` in this package - and then the same programs in a browser (`browser-v`'s
   page). What a stale or wrong compiler breaks first is `import`s and `println`, which the suite covers.

## Things not to do

- **Do not re-pin by accepting whatever arrives.** Deleting the receipts and letting the first read
  define them is the difference between a pin and a receipt: it would adopt changed bytes silently,
  which is the whole failure mode this pin exists to catch.
- **Do not edit `v.js` or `v.wasm` by hand.** They are Emscripten builds with the patches above already
  applied, and a change to them is a change nobody can reproduce from source.
