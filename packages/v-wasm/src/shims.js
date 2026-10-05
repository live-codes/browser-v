// What V's generated C needs before the browser C->wasm toolchain can build it.
//
// V 0.5.2's C backend targets wasm32_emscripten, and the C it emits is portable, but it includes a
// batch of POSIX headers. `@live-codes/clang-wasm` restores wasi-libc's whole C header tree, which
// covers almost all of them; what is left here is short, and none of it is a prune:
//
//   netdb.h, sys/wait.h, termios.h   wasi-libc does not ship these at all.
//   stdatomic.h                      Clang's own header; the packaged Clang resource directory is
//                                    pruned to the headers <stdarg.h> and <stddef.h> need.
//   getpid()                         WASI has no process ids. wasi-libc emulates it behind a define
//                                    and a library the link line does not carry, and this is the one
//                                    function V's generated C actually calls.
//
// The four headers that are present but refuse to compile without a feature flag are handled with the
// flags instead of a file - see COMPILE_ARGS. That keeps the sysroot's own declarations, which a stub
// could not do.

export const SYSROOT_INCLUDE = 'include/wasm32-wasi';

// Absent from wasi-libc, and included by V's non-Windows preamble. Nothing in the generated C calls
// into them for the programs this package compiles.
const EMPTY_HEADERS = ['netdb.h', 'sys/wait.h', 'termios.h'];

export const SHIMS = {};

EMPTY_HEADERS.forEach((header) => {
	const guard = 'V_SHIM_' + header.toUpperCase().replace(/[^A-Z0-9]+/g, '_');
	SHIMS[`${SYSROOT_INCLUDE}/${header}`] =
		`#ifndef ${guard}\n#define ${guard}\n#endif\n`;
});

// The generated C does its atomics with clang's __atomic_* builtins, so only the names the preamble
// touches are needed.
SHIMS[`${SYSROOT_INCLUDE}/stdatomic.h`] =
	'#ifndef V_SHIM_STDATOMIC_H\n' +
	'#define V_SHIM_STDATOMIC_H\n' +
	'typedef enum { memory_order_relaxed = 0, memory_order_consume = 1,\n' +
	'\tmemory_order_acquire = 2, memory_order_release = 3,\n' +
	'\tmemory_order_acq_rel = 4, memory_order_seq_cst = 5 } memory_order;\n' +
	'#define ATOMIC_VAR_INIT(value) (value)\n' +
	'#define atomic_init(obj, value) (*(obj) = (value))\n' +
	'#endif\n';

// Two libc functions V's generated C calls that wasi-libc does not provide, so both the declaration
// and the link symbol have to come from here. They are defined rather than merely declared because
// they are referenced unconditionally, so the symbol has to resolve at link time even though a
// playground program never reaches them.
//
//   getpid()   WASI has no process ids. pid_t is int in wasi-libc, so this matches the real
//              declaration in <unistd.h>.
//   pipe()     WASI has no pipes. V's `os` module includes os/execute_capture_nix.h, which creates a
//              pipe to capture a child's output, so any program that imports `os` at all needs the
//              symbol - even one that only reads `os.args`. Returning failure is honest: a program
//              that actually calls os.execute cannot be given a child process in WASI anyway.
export const SOURCE_PATCHES =
	'int getpid(void) { return 1; }\n' + 'int pipe(int fds[2]) { (void)fds; return -1; }\n';

// wasi-libc gates four headers V includes behind an #error naming the option. Passing the option
// keeps the sysroot's own declarations rather than a stub: nothing here calls mmap, signal or the
// process clocks, so only the headers' contents are wanted - the emulation libraries are not on the
// link line. <setjmp.h> is the same shape and wants the exception-handling macro; nothing calls
// setjmp either (WebAssembly has no setjmp without the EH proposal).
export const COMPILE_ARGS = [
	'-w',
	'-D_WASI_EMULATED_MMAN',
	'-D_WASI_EMULATED_SIGNAL',
	'-D_WASI_EMULATED_PROCESS_CLOCKS',
	'-D__wasm_exception_handling__'
];
