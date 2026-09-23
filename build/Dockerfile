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
ENV V_COMMIT=${V_COMMIT} EMCC_OPT=${EMCC_OPT} OUT=/out

COPY build-v-wasm.sh /build/build-v-wasm.sh
RUN chmod +x /build/build-v-wasm.sh
RUN /build/build-v-wasm.sh

FROM scratch AS export
COPY --from=builder /out /
