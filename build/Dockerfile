# Builds the V compiler and standard library for the browser, reproducibly.
#
#   docker build --output type=local,dest=./assets .
#
# Produces assets/v.js, assets/v.wasm, assets/vlib.tar and assets/receipt.json.
# Building the compiler to wasm takes a few minutes; Docker caches the layers, so
# re-running only rebuilds when V_COMMIT or the scripts change.
#
# The Emscripten image is pinned by tag and digest - 6.0.10 is the emcc version the committed
# receipt.json records - and the V source is pinned by commit. Both are on purpose: the tag says which
# release this is, the digest says which bytes, so a moved `latest` cannot change the artifacts.
FROM emscripten/emsdk:6.0.10@sha256:e077d54e2b8970575ebc4f185ac1de0b95c05f2b266134d4ba27449af7aebf65 AS builder

ARG V_COMMIT=e1ec613778753bfe9cd35f9178d472a9def890bf
# emcc's optimisation level, and the binaryen wasm-opt level applied to the linked module afterwards.
#
# The committed module is the emcc -O0 build the earlier pipeline produced, post-optimized with
# `wasm-opt -O2 --strip-debug`, so -O0 is what those bytes came from. Raising EMCC_OPT would shrink and
# speed up the compiler further, but a full recompile is currently blocked by a self-hosting bootstrap
# failure in the pinned emsdk image (see docs/ASSETS.md), so this stays at the level that is known to
# produce a working compiler.
ARG EMCC_OPT=-O0
ARG WASM_OPT=-O2
# INCLUDE_WASM_BACKEND=1 keeps V's own WebAssembly code generator in the compiler. It builds, but the
# resulting compiler cannot run - see build-v-wasm.sh, which records both reasons it is off by default.
ARG INCLUDE_WASM_BACKEND=0
ENV V_COMMIT=${V_COMMIT} EMCC_OPT=${EMCC_OPT} WASM_OPT=${WASM_OPT} OUT=/out INCLUDE_WASM_BACKEND=${INCLUDE_WASM_BACKEND}

# The stubs are an input to the final emcc link, and the script finds them next to itself, so both
# files have to land in /build - copying only the script fails at the link with
# "emcc: error: /build/v-wasm-stubs.c: No such file or directory".
COPY build-v-wasm.sh v-wasm-stubs.c /build/
RUN chmod +x /build/build-v-wasm.sh
RUN /build/build-v-wasm.sh

FROM scratch AS export
COPY --from=builder /out /
