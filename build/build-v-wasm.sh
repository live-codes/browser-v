#!/usr/bin/env bash
#
# Builds the V compiler for the browser, entirely inside an Emscripten container.
#
# Outputs (to $OUT, default /out):
#   v.js        Emscripten loader for the compiler
#   v.wasm      the V compiler, compiled from C to wasm32
#   vlib.tar    the full V standard library the compiler compiles against
#   receipt.json  what was built, and from what
#
# The compiler is built with the C backend targeted at wasm32_emscripten, then
# linked with emcc. The V repository is checked out at a pinned commit, so the
# same inputs always produce the same artifacts.
set -euo pipefail

V_COMMIT="${V_COMMIT:-e1ec613778753bfe9cd35f9178d472a9def890bf}"
VROOT="${VROOT:-/v}"
WORK="${WORK:-/work}"
OUT="${OUT:-/out}"
EMCC_OPT="${EMCC_OPT:--O0}"
# binaryen's wasm-opt level, applied to the linked module after emcc. It is off by default and
# separate from EMCC_OPT because the two can be chosen independently: emcc's own optimisation
# changes the generated code, while wasm-opt cleans up what is already there. `--strip-debug` is
# always passed alongside it, dropping the names section the -O0 build carries. `-Oz` on a module
# this size takes tens of minutes, so `-O2` is the level worth using here.
WASM_OPT="${WASM_OPT:-}"
# The emsdk image keeps binaryen under /emsdk/upstream/bin, which is not always on PATH.
WASM_OPT_BIN="${WASM_OPT_BIN:-/emsdk/upstream/bin/wasm-opt}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STUBS="$SCRIPT_DIR/v-wasm-stubs.c"

# STUB_DEBUG=1 makes the synchronous thread/semaphore stubs log every call, which
# is how the compiler's concurrency is investigated. Off by default.
STUB_DEBUG_FLAG=""
if [ "${STUB_DEBUG:-0}" = "1" ]; then
  STUB_DEBUG_FLAG="-DV_STUB_DEBUG"
fi

mkdir -p "$WORK" "$OUT"

log() { printf '\n=== %s ===\n' "$*"; }

log "tools"
emcc --version | head -n 1
node --version || true
git --version || true

log "fetch V @ $V_COMMIT"
curl -fsSL "https://codeload.github.com/vlang/v/tar.gz/$V_COMMIT" -o "$WORK/v.tar.gz"
rm -rf "$VROOT"
mkdir -p "$VROOT"
tar -xzf "$WORK/v.tar.gz" -C "$VROOT" --strip-components=1

cd "$VROOT"

log "patch os.user_os() for the wasm host"
# os.user_os() has no wasm32_emscripten branch, so a compiler built for the
# browser sees its own host as `unknown/wasm32` and panics on startup with
# "unsupported compiler host target unknown/wasm32". Teach it its own name.
python3 - <<'PY'
import pathlib
p = pathlib.Path('/v/vlib/os/os.v')
src = p.read_text()
anchor = 'pub fn user_os() string {\n'
addition = anchor + "\t$if wasm32_emscripten {\n\t\treturn 'wasm32_emscripten'\n\t}\n"
assert anchor in src, 'os.user_os() anchor not found'
assert addition not in src, 'os.user_os() already patched'
p.write_text(src.replace(anchor, addition, 1))
print('patched', p)
PY

log "patch the driver's native-input scan"
# Before the checker runs, V resolves "native inputs": it asks the C compiler for
# its predefined macros and follows #include paths. A browser has no C toolchain
# to ask, and there the scan never returns — it is also useless, because a program
# compiled here has no C interop. All three entry points are neutralised:
#   - the scan itself, in both its plain and module-cache forms;
#   - the overlap that would run it on a spawned thread. That one matters for a
#     second reason: our synchronous pthread stub runs the thread body inline, and
#     the body waits for a release the caller only sends after spawn returns, so
#     the overlap would deadlock even if the scan were cheap.
python3 - <<'PY'
import pathlib
p = pathlib.Path('/v/vlib/v/driver/driver.v')
src = p.read_text()

# The early exits are wrapped in `$if wasm32_emscripten`, exactly like the os.user_os() and C-output
# patches. That matters for a second reason beyond target selection: the native bootstrap and the
# native V3 are built from this same source and must keep the real body, and a bare `return` would
# leave the rest of the body as unreachable code, which V refuses to compile ("error: unreachable
# code"). For the wasm target the block is kept, and its `return` never falls through.
note = '\t$if wasm32_emscripten {\n\t\t// browser-v: no C toolchain to query or resolve includes with\n\t\treturn\n\t}'

overlap = '\treturn (native_inputs_needed && building_v) || (!native_inputs_needed && scope_prealloc_stages)'
assert overlap in src, 'overlap return not found'
src = src.replace(overlap, '\t// browser-v: never overlap; the scan cannot run without a C toolchain\n\treturn false', 1)

plain = 'fn prepare_v3_checker_native_inputs(mut state V3ModuleCacheState, a &flat.FlatAst, prefs &pref.Preferences, user_files []string, user_c_flags []string, c_compiler string) {'
assert plain in src, 'prepare_v3_checker_native_inputs not found'
src = src.replace(plain, plain + '\n' + note, 1)

cached = 'fn prepare_v3_cache_external_inputs_scoped(mut state V3ModuleCacheState, a &flat.FlatAst, prefs &pref.Preferences, user_files []string, user_c_flags []string, c_compiler string, scope_enabled bool) bool {'
assert cached in src, 'prepare_v3_cache_external_inputs_scoped not found'
src = src.replace(cached, cached + '\n\t$if wasm32_emscripten {\n\t\t// browser-v: no C toolchain to query or resolve includes with\n\t\treturn false\n\t}', 1)

p.write_text(src)
print('patched', p)
PY

log "patch the C output writer for Emscripten"
# V writes the generated C through an mmap(MAP_SHARED) of the output file, sized
# with ftruncate, and relies on the shared mapping to publish the bytes. That is
# true on Linux, but Emscripten's mmap of an in-memory file does not write back:
# the file ends up at exactly the right size and full of NUL. Force the
# sequential writer on this target only.
python3 - <<'PY'
import pathlib
p = pathlib.Path('/v/vlib/v/gen/c/output_nix.c.v')
src = p.read_text()
sig = 'fn write_c_output_mapped(path string, prefix []u8, segments []string, tail string, separator string) ! {'
assert sig in src, 'write_c_output_mapped not found'
patched = sig + '''
\t// browser-v: the mmap(MAP_SHARED) path below assumes the mapping publishes the
\t// bytes to the file. Emscripten's mmap of an in-memory file does not write
\t// back, which leaves a correctly sized file full of NUL, so write it instead.
\t$if wasm32_emscripten {
\t\tmut sequential_file := os.open_file(path, 'wb')!
\t\twrite_c_output_sequential(mut sequential_file, prefix, segments, tail, separator) or {
\t\t\tsequential_file.close()
\t\t\treturn err
\t\t}
\t\tsequential_file.close()
\t\treturn
\t}'''
p.write_text(src.replace(sig, patched, 1))
print('patched', p)
PY

if [ "${DRIVER_TRACE:-0}" = "1" ]; then
log "trace patch: marking driver phases"
python3 - <<'PY'
import pathlib
p = pathlib.Path('/v/vlib/v/driver/driver.v')
src = p.read_text()

def before(anchor, marker, s):
    assert anchor in s, 'anchor not found: ' + anchor
    return s.replace(anchor, "\teprintln('[trace] " + marker + "')\n" + anchor, 1)

def after(anchor, marker, s):
    assert anchor in s, 'anchor not found: ' + anchor
    return s.replace(anchor, anchor + "\n\teprintln('[trace] " + marker + "')", 1)

src = after("eprintln('  [ttime]   ri collision   ${ri_coll_ms:7.2f} ms, wave scan ${ri_wave_ms:.2f} ms (waves: ${ri_waves})')", 'TR0 ri done', src)
src = after("resolve_imports(mut a, mut p, prefs, user_files, !current_no_parallel, skip_closure_runtime, mut cache_state, mut parse_timing)", 'TR1 after resolve_imports', src)
src = after("_ = stage_macos_v3_fallback_source_digests(macos_v3_c_error_dir, fallback_report_sources)", 'TR2 after stage digests', src)
src = after("native_inputs_overlap := should_overlap_v3_native_inputs(backend, cache_state.external_inputs_ready, cache_state.manager.enabled, native_inputs_needed, building_v, scope_prealloc_stages)", 'TR3 after native inputs', src)
src = before("prepared_markused_thread := spawn markused.prepare_markused_declarations(a, &pre_tc, prepare_markused_overlap)", 'TR4 before markused spawn', src)
src = before("prepared_transform_thread := spawn transform.prepare_selfhost_transform(a, &pre_tc, prepare_transform_overlap)", 'TR5 before transform spawn', src)
src = after("native_inputs_done := chan bool{cap: 1}", 'TA chan done created', src)
src = after("native_inputs_release := chan bool{cap: 1}", 'TB chan release created', src)
src = before("native_inputs_args := PrepareV3CheckerNativeInputsArgs{", 'TC before args struct', src)
src = before("if !native_inputs_overlap && backend == 'c' && cache_state.external_inputs_ready {", 'TD after native inputs block', src)
p.write_text(src)
print('driver trace patches applied')
PY
fi

log "bootstrap native V (make)"
make
log "native V version"
./v version

log "build a native V3 from the pinned source"
./v -o "$WORK/v3" cmd/v
"$WORK/v3" version

log "generate C for the compiler, targeted at wasm32_emscripten"
# INCLUDE_WASM_BACKEND=1 keeps V's own WebAssembly code generator in the compiler, so it could do
# `-b wasm -os wasi` and emit a module directly - no C, no clang, no sysroot. It is off by default
# because it does not work here yet. Measured against these samples, with the rebuilt compiler:
#
#   min        63 B   runs, no output (it is an empty main)
#   t_fib     373 B   runs, prints "0" ten times - string interpolation is a stub
#   t_interp  304 B   runs, prints "0"          - string concatenation is a stub
#   t_math   1004 B   runs, prints "0"          - f64.str and frexp are unsupported
#   t_arrays     -    fails: `wasm error: get_wasm_type: unreachable type '[]int'`
#   t_struct     -    fails
#
# The generator reports those as `[v!] wasm: unsupported expr/call: ...` *warnings* and carries on, so
# the module builds, runs, and prints the wrong answer - worse for a playground than refusing. It is
# V3's port of the generator (it works off the flat AST) and covers much less than the 0.5.2 release's,
# which did handle interpolation and structs.
#
# Separately: with the generator compiled in, an emcc -O1 build cannot parse a command line at all -
# every invocation, `-version` included, dies with `option '<x>' requires a value`. EMCC_OPT=-O0 clears
# that (and is ~12x faster: 2m41s against 34m), so the misfire is optimisation-dependent, and it is
# specific to this Emscripten/wasm32_emscripten build: a native Linux build of the same pinned source
# with the same flag answers `-version` and emits a valid module.
WASM_BACKEND_FLAG=""
if [ "${INCLUDE_WASM_BACKEND:-0}" = "1" ]; then
  WASM_BACKEND_FLAG="-compile-backend wasm"
fi
"$WORK/v3" -os wasm32_emscripten $WASM_BACKEND_FLAG -o "$WORK/v.c" cmd/v

log "compile the compiler to wasm with emcc"
emcc "$WORK/v.c" "$STUBS" -o "$OUT/v.js" \
  "$EMCC_OPT" \
  -w \
  $STUB_DEBUG_FLAG \
  -Wl,--wrap=pthread_create \
  -Wl,--wrap=pthread_join \
  -Wl,--wrap=sem_init \
  -Wl,--wrap=sem_destroy \
  -Wl,--wrap=sem_post \
  -Wl,--wrap=sem_wait \
  -Wl,--wrap=sem_trywait \
  -Wl,--wrap=sem_timedwait \
  -sMODULARIZE=1 \
  -sEXPORT_NAME=createVCompiler \
  -sEXPORTED_RUNTIME_METHODS=FS,callMain \
  -sALLOW_MEMORY_GROWTH=1 \
  -sINITIAL_MEMORY=67108864 \
  -sSTACK_SIZE=16777216 \
  -sINVOKE_RUN=0 \
  -sEXIT_RUNTIME=0 \
  -sFORCE_FILESYSTEM=1 \
  -sENVIRONMENT=web,worker,node \
  -sASSERTIONS=0

log "optimize the linked module with binaryen"
if [ -n "$WASM_OPT" ]; then
  before=$(stat -c %s "$OUT/v.wasm")
  "$WASM_OPT_BIN" "$WASM_OPT" --strip-debug "$OUT/v.wasm" -o "$OUT/v.wasm.opt"
  mv "$OUT/v.wasm.opt" "$OUT/v.wasm"
  after=$(stat -c %s "$OUT/v.wasm")
  echo "wasm-opt $WASM_OPT --strip-debug: $before -> $after bytes"
else
  echo "wasm-opt: skipped (set WASM_OPT, e.g. -O2)"
fi

log "pack the standard library"
# The library sources a user program can import, without the compiler's own
# sources (vlib/v), test files or docs. That is what keeps the download in the
# low megabytes instead of tens of them.
tar -cf "$OUT/vlib.tar" -C "$VROOT" \
  --exclude='vlib/v' \
  --exclude='vlib/v/*' \
  --exclude='*_test.v' \
  --exclude='*/tests' \
  --exclude='*/tests/*' \
  --exclude='*.md' \
  --exclude='*.json' \
  --exclude='*.out' \
  vlib

# All of the compiler is compiled into v.wasm, but a few of its own files are
# still read from disk at run time: the header behind an $embed_file (Emscripten
# is a cross target, so $embed_file reads rather than embeds), and the preludes
# it injects. Add just those back.
tar -rf "$OUT/vlib.tar" -C "$VROOT" \
  --exclude='*_test.v' \
  --exclude='*.md' \
  vlib/v/preludes \
  vlib/v/embed_file \
  vlib/v/gen/c/manual_stdlib_c_headers.h
echo "vlib.tar: $(du -h "$OUT/vlib.tar" | cut -f1)"

log "gzip the two large assets"
# Shipped compressed so the size a host transfers does not depend on the host compressing anything
# itself; the package inflates them in JavaScript. `-f` rewrites in place to `<name>.gz`.
gzip -9 -f "$OUT/v.wasm"
gzip -9 -f "$OUT/vlib.tar"
ls -l "$OUT/v.wasm.gz" "$OUT/vlib.tar.gz"

log "receipt"
V_VERSION="$("$WORK/v3" version | tr -d '\r')"
WASM_OPT_VERSION="none"
if [ -n "$WASM_OPT" ]; then
  WASM_OPT_VERSION="$("$WASM_OPT_BIN" --version 2>/dev/null | tr -d '\r')"
fi
cat > "$OUT/receipt.json" <<EOF
{
  "v_commit": "$V_COMMIT",
  "v_version": "$V_VERSION",
  "emcc": "$(emcc --version | head -n 1 | tr -d '\r')",
  "emcc_opt": "$EMCC_OPT",
  "wasm_opt": "${WASM_OPT:-none}${WASM_OPT:+ --strip-debug}",
  "wasm_opt_version": "$WASM_OPT_VERSION",
  "artifacts": {
    "v.js": "$(sha256sum "$OUT/v.js" | cut -d' ' -f1)",
    "v.wasm.gz": "$(sha256sum "$OUT/v.wasm.gz" | cut -d' ' -f1)",
    "vlib.tar.gz": "$(sha256sum "$OUT/vlib.tar.gz" | cut -d' ' -f1)"
  }
}
EOF

log "done"
cat "$OUT/receipt.json"
ls -la "$OUT"
