# Third-party notices

This package is MIT - see [LICENSE](./LICENSE). It ships a build of the V compiler, and depends on
another package that ships the C toolchain.

## `assets/v/` - the V compiler, compiled to WebAssembly

| File | What it is | Licence |
| --- | --- | --- |
| `v.wasm`, `v.js` | V 0.5.2, compiled from C to wasm32_emscripten with Emscripten | MIT |
| `vlib.tar` | The V standard library the compiler compiles against | MIT |

- **V**, and its standard library, are MIT, copyright the V contributors.
  <https://github.com/vlang/v>
- **The build is this repository's own**, not a third-party prebuilt: the artifacts come from
  `build/build-v-wasm.sh` at V commit `e1ec6137`, run inside `build/Dockerfile`. Where exactly they came
  from, and the SHA-256 of each file, is recorded in [`src/asset-receipts.js`](./src/asset-receipts.js),
  and every read of them is checked against it. They are pinned so that the dependency is at least
  immutable and traceable.

**Emscripten** is used at build time only and is not distributed in this package; it is Apache-2.0 with
the LLVM exception. <https://emscripten.org>

## The Clang toolchain - a dependency, not shipped here

The C that V emits is compiled and linked with
[`@live-codes/clang-wasm`](https://www.npmjs.com/package/@live-codes/clang-wasm). That package's assets -
Clang, LLD, memfs and the WASI sysroot - keep their own permissive licences: **Apache-2.0 with the LLVM
exception** for Clang, LLD, memfs and the sysroot. Its own `THIRD-PARTY-NOTICES.md` lists them one by
one. The IIFE build additionally bundles `@wasm-idle/llvm-core` (MIT AND Apache-2.0 WITH
LLVM-exception), `@bjorn3/browser_wasi_shim` (MIT OR Apache-2.0) and `fflate` (MIT).

None of it is copyleft, and none of it constrains the programs you compile.
