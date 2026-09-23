/*
 * What V's generated C needs before the browser C->wasm toolchain can build it.
 *
 * V 0.5.2's C backend targets wasm32_emscripten, and the C it emits is portable,
 * but it includes a batch of POSIX headers. This file used to stand in for about
 * twenty of them, because the sysroot that ships with the toolchain was pruned to
 * what a C++ demo needs. That prune was a defect in @live-codes/clang-wasm rather
 * than a limitation of V: it kept <unistd.h> and dropped the two headers <unistd.h
 * includes, so the file could not be preprocessed at all. The package now restores
 * wasi-libc's whole C header tree, and almost every shim here is gone with it.
 *
 * What is left is short, and none of it is a prune:
 *
 *   netdb.h, sys/wait.h, termios.h   wasi-libc does not ship these at all.
 *   stdatomic.h                      Clang's own header; the packaged Clang
 *                                    resource directory is pruned to the headers
 *                                    <stdarg.h> and <stddef.h> need.
 *   getpid()                         WASI has no process ids. wasi-libc emulates
 *                                    it behind a define and a library the link
 *                                    line does not carry, and this is the one
 *                                    function V's generated C actually calls.
 *
 * The four headers that are present but refuse to compile without a feature flag
 * are handled with the flags instead of a file: see COMPILE_ARGS. That keeps the
 * sysroot's own declarations, which is what the old stubs could not do.
 *
 * Shared by the page's worker and the Node dev driver (build/dev-run.mjs), so
 * there is one copy of the list.
 */
(function () {
  var SYSROOT_INCLUDE = 'include/wasm32-wasi';

  // Absent from wasi-libc, and included by V's non-Windows preamble. Nothing in
  // the generated C calls into them for the programs this PoC compiles.
  var EMPTY_HEADERS = ['netdb.h', 'sys/wait.h', 'termios.h'];

  var SHIMS = {};

  EMPTY_HEADERS.forEach(function (header) {
    var guard = 'V_SHIM_' + header.toUpperCase().replace(/[^A-Z0-9]+/g, '_');
    SHIMS[SYSROOT_INCLUDE + '/' + header] =
      '#ifndef ' + guard + '\n#define ' + guard + '\n#endif\n';
  });

  // The generated C does its atomics with clang's __atomic_* builtins, so only
  // the names the preamble touches are needed.
  SHIMS[SYSROOT_INCLUDE + '/stdatomic.h'] =
    '#ifndef V_SHIM_STDATOMIC_H\n' +
    '#define V_SHIM_STDATOMIC_H\n' +
    'typedef enum { memory_order_relaxed = 0, memory_order_consume = 1,\n' +
    '\tmemory_order_acquire = 2, memory_order_release = 3,\n' +
    '\tmemory_order_acq_rel = 4, memory_order_seq_cst = 5 } memory_order;\n' +
    '#define ATOMIC_VAR_INIT(value) (value)\n' +
    '#define atomic_init(obj, value) (*(obj) = (value))\n' +
    '#endif\n';

  // WASI has no process ids, and this is the one libc function the generated C
  // calls (for a seed). pid_t is int in wasi-libc, so this matches the real
  // declaration in <unistd.h> now that that header is the sysroot's own.
  var SOURCE_PATCHES = 'int getpid(void) { return 1; }\n';

  // wasi-libc gates four headers V includes behind an #error naming the option.
  // Passing the option keeps the sysroot's own declarations rather than a stub:
  // nothing here calls mmap, signal or the process clocks, so only the headers'
  // contents are wanted - the emulation libraries are not on the link line.
  // <setjmp.h> is the same shape and wants the exception-handling macro; nothing
  // calls setjmp either (WebAssembly has no setjmp without the EH proposal).
  var COMPILE_ARGS = [
    '-w',
    '-D_WASI_EMULATED_MMAN',
    '-D_WASI_EMULATED_SIGNAL',
    '-D_WASI_EMULATED_PROCESS_CLOCKS',
    '-D__wasm_exception_handling__',
  ];

  // The mode name is the runtime's ('C', 'CPP', 'objective-c'), not a file suffix.
  globalThis.LiveCodesVClang = {
    SHIMS: SHIMS,
    SOURCE_PATCHES: SOURCE_PATCHES,
    COMPILE_ARGS: COMPILE_ARGS,
  };
})();
