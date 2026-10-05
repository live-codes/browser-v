# The compiler assets: where they come from, and how to move them

`assets/v/` holds the V compiler, compiled to WebAssembly. Unlike the sibling `@live-codes/nim-wasm`,
it is **not** a third-party prebuilt: it is built from a pinned V commit by this repository's own
container pipeline. This file records what the files are, how they are produced, and what to do when
they need to be replaced.

## What the three files are

| File | Size | What it is |
| --- | --- | --- |
| `v.js` | 157 KB | The Emscripten loader for the compiler |
| `v.wasm.gz` | 4.97 MB | The V 0.5.2 compiler, compiled from C to wasm32_emscripten, optimised, gzipped (13.95 MB before gzip) |
| `vlib.tar.gz` | 3.22 MB | The V standard library the compiler compiles against, pruned, packed and gzipped (14.06 MB before gzip) |

The first two are a matched pair: `v.js` loads `v.wasm` through `Module.instantiateWasm` (Node, from
these bytes) or `Module.locateFile` (a browser, by URL). Replacing one without the other will not work.
`vlib.tar` is unpacked into the compiler's memory filesystem at `/v`, and the generated C includes its
files by that absolute path.

The two large assets are shipped gzipped and inflated in JavaScript (see `src/inflate.js`), so the size
a host transfers does not depend on the host compressing anything itself. A page therefore pulls about
8.2 MB rather than about 32 MB.

## Where they come from

- **The language**: V **0.5.2**, MIT, at commit `e1ec613778753bfe9cd35f9178d472a9def890bf`.
  <https://github.com/vlang/v>
- **The build**: [`build/build-v-wasm.sh`](../../../build/build-v-wasm.sh), run inside
  [`build/Dockerfile`](../../../build/Dockerfile) by `npm run build:assets` at the repository root.

The exact bytes are pinned by size and SHA-256 in [`src/asset-receipts.js`](../src/asset-receipts.js),
along with that provenance, and every read is verified against the pin. A host serving something else
fails with both digests rather than running a different compiler.

## How they are built

Everything is in `build/build-v-wasm.sh`; the summary is:

1. Fetch V at the pinned commit and patch it. Each patch exists because the wasm build has no C
   toolchain and no threads, and V's compiler assumes both. The patches to `os.user_os()`, the driver's
   native-input scan and the C output writer are all wrapped in `$if wasm32_emscripten`, so the native
   bootstrap and native V3 — built from this same source — keep their real bodies; a bare `return`
   would leave the rest of the body as unreachable code, which V refuses to compile.
2. Bootstrap a native V, build a native V3 from the pinned sources, and generate C for the compiler with
   `-os wasm32_emscripten`.
3. Compile that C to `v.js` + `v.wasm` with `emcc` (currently `-O0`).
4. Optimise the linked module with binaryen: `wasm-opt -O2 --strip-debug` (13.95 MB, from 17.23 MB).
5. Pack the standard library into `vlib.tar`, pruned of test files, docs and the compiler's own `vlib/v`
   tree (which is already compiled into `v.wasm`), with the few files read at run time added back.
6. `gzip -9` the module and the archive, so the package ships `v.wasm.gz` and `vlib.tar.gz`.
7. Write `receipt.json` with the V commit, the emcc and binaryen versions, and the SHA-256 of every
   artifact.

### A full recompile is currently blocked

Raising `EMCC_OPT` above `-O0` would shrink and speed up the compiler further, but a complete rebuild
fails today at the *native* bootstrap: `make` builds V2 with the `vc/v.c` bootstrap compiler and the
linker reports `undefined reference to array_sort_move` (V's bundled `tcc` also fails, for a missing
`vlib/sync/stdatomic/atomic_fence_amd64.S`). That is a self-hosting/bootstrap problem in the pinned V
commit and emsdk image, not something the pipeline can flag around, so `EMCC_OPT` stays at `-O0`, which
is the level the shipped bytes came from. Fixing it is the remaining engine work, and would also let the
`-O2` emcc path be re-measured.

## How to move the pin

The build writes straight into the package:

```bash
npm run build:assets       # docker build --output type=local,dest=./packages/v-wasm/assets/v build
```

That updates `v.js`, `v.wasm.gz`, `vlib.tar.gz` and `receipt.json` in `packages/v-wasm/assets/v/`. To
carry a new build into the package:

1. Take the SHA-256s from the new `receipt.json` (or compute them) and paste them into
   `packages/v-wasm/src/asset-receipts.js`, updating `ASSET_SOURCE` alongside them — the V commit, and
   the compiler version or optimisation level if those changed too. A pin without its provenance is
   only half the record.
2. Rebuild the IIFE bundle (`npm run build:iife` in this package). The receipts are bundled into
   `dist/v-wasm.global.js`, so it carries the old pin until it is rebuilt.
3. Run the tests — `npm test` in this package — and then the same programs in a browser (`browser-v`'s
   page). What a stale or wrong compiler breaks first is `import`s and `println`, which the suite covers.

## Things not to do

- **Do not re-pin by accepting whatever arrives.** Deleting the receipts and letting the first read
  define them is the difference between a pin and a receipt: it would adopt changed bytes silently,
  which is the whole failure mode this pin exists to catch.
- **Do not edit `v.js`, `v.wasm` or `vlib.tar` by hand.** They are Emscripten and `tar` output with the
  patches above already applied, and a change to them is a change nobody can reproduce from source.
- **Do not commit the uncompressed `v.wasm` or `vlib.tar`.** The package and the pipeline gzip them on
  purpose; the raw files are build intermediates.
