# Builds the V compiler and standard library for the browser, reproducibly.
#
#   docker build --output type=local,dest=./assets .
#
# Produces assets/v.js, assets/v.wasm, assets/vlib.tar and assets/receipt.json.
# Building the compiler to wasm takes a few minutes; Docker caches the layers, so
# re-running only rebuilds when V_COMMIT or the scripts change.
#
# The Emscripten image is pinned by digest; the V source is pinned by commit.
FROM emscripten/emsdk:latest AS builder

ARG V_COMMIT=e1ec613778753bfe9cd35f9178d472a9def890bf
ARG EMCC_OPT=-O1
# INCLUDE_WASM_BACKEND=1 keeps V's own WebAssembly code generator in the compiler. It builds, but the
# resulting compiler cannot run - see build-v-wasm.sh, which records both reasons it is off by default.
ARG INCLUDE_WASM_BACKEND=0
ENV V_COMMIT=${V_COMMIT} EMCC_OPT=${EMCC_OPT} OUT=/out INCLUDE_WASM_BACKEND=${INCLUDE_WASM_BACKEND}

# The stubs are an input to the final emcc link, and the script finds them next to itself, so both
# files have to land in /build - copying only the script fails at the link with
# "emcc: error: /build/v-wasm-stubs.c: No such file or directory".
COPY build-v-wasm.sh v-wasm-stubs.c /build/
RUN chmod +x /build/build-v-wasm.sh
RUN /build/build-v-wasm.sh

FROM scratch AS export
COPY --from=builder /out /
