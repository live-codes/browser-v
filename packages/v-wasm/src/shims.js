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

// The generated C does its atomics with Clang's __atomic_* builtins, but it still names the C11
// atomic types - `sync`'s structures hold `atomic_uintptr_t` fields, which is what `time`, `sync` and
// `benchmark` need. Only this package's Clang resource directory is pruned, so the whole header has to
// come from here: the standard type names, the memory orders, and the handful of macros mapped onto
// the builtins. The types are plain scalars rather than `_Atomic`: a WASI process is one thread here
// (the thread stubs are synchronous), and the generated code passes their addresses to the builtins.
SHIMS[`${SYSROOT_INCLUDE}/stdatomic.h`] = `#ifndef V_SHIM_STDATOMIC_H
#define V_SHIM_STDATOMIC_H

typedef enum {
	memory_order_relaxed = 0,
	memory_order_consume = 1,
	memory_order_acquire = 2,
	memory_order_release = 3,
	memory_order_acq_rel = 4,
	memory_order_seq_cst = 5
} memory_order;

typedef _Bool atomic_bool;
typedef char atomic_char;
typedef signed char atomic_schar;
typedef unsigned char atomic_uchar;
typedef short atomic_short;
typedef unsigned short atomic_ushort;
typedef int atomic_int;
typedef unsigned int atomic_uint;
typedef long atomic_long;
typedef unsigned long atomic_ulong;
typedef long long atomic_llong;
typedef unsigned long long atomic_ullong;
typedef __SIZE_TYPE__ atomic_size_t;
typedef __PTRDIFF_TYPE__ atomic_ptrdiff_t;
typedef __INTPTR_TYPE__ atomic_intptr_t;
typedef __UINTPTR_TYPE__ atomic_uintptr_t;

typedef struct { atomic_bool value; } atomic_flag;
#define ATOMIC_FLAG_INIT { 0 }
#define ATOMIC_VAR_INIT(value) (value)

#define atomic_init(obj, value) (*(obj) = (value))
#define atomic_load(obj) __atomic_load_n((obj), memory_order_seq_cst)
#define atomic_load_explicit(obj, order) __atomic_load_n((obj), (order))
#define atomic_store(obj, value) __atomic_store_n((obj), (value), memory_order_seq_cst)
#define atomic_store_explicit(obj, value, order) __atomic_store_n((obj), (value), (order))
#define atomic_exchange(obj, value) __atomic_exchange_n((obj), (value), memory_order_seq_cst)
#define atomic_exchange_explicit(obj, value, order) __atomic_exchange_n((obj), (value), (order))
#define atomic_fetch_add(obj, arg) __atomic_fetch_add((obj), (arg), memory_order_seq_cst)
#define atomic_fetch_sub(obj, arg) __atomic_fetch_sub((obj), (arg), memory_order_seq_cst)
#define atomic_fetch_or(obj, arg) __atomic_fetch_or((obj), (arg), memory_order_seq_cst)
#define atomic_fetch_and(obj, arg) __atomic_fetch_and((obj), (arg), memory_order_seq_cst)
#define atomic_compare_exchange_strong(obj, expected, desired) \\
	__atomic_compare_exchange_n((obj), (expected), (desired), 0, memory_order_seq_cst, memory_order_seq_cst)
#define atomic_compare_exchange_weak(obj, expected, desired) \\
	__atomic_compare_exchange_n((obj), (expected), (desired), 1, memory_order_seq_cst, memory_order_seq_cst)
#define atomic_flag_test_and_set(obj) __atomic_test_and_set((obj), memory_order_seq_cst)
#define atomic_flag_clear(obj) __atomic_clear((obj), memory_order_seq_cst)
#define atomic_thread_fence(order) __atomic_thread_fence(order)
#define atomic_signal_fence(order) __atomic_signal_fence(order)

#endif
`;

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

// WASI has no semaphores either, and V's `sync` module implements `Semaphore` over the POSIX ones.
// `time`, `benchmark` and `rand` all reach it, so a program that only asks for the clock still needs
// the symbols to link. These mirror the stubs the compiler itself is built with: a counter in the
// first bytes of the `sem_t`, and a wait that cannot block, which is correct because a WASI process
// here is one thread. Unlike the two patches above, these are appended after the generated C, so
// `sem_t` and `struct timespec` are already known from the headers it includes.
export const SOURCE_SUFFIX = `
#include <time.h>
#include <semaphore.h>

int sem_init(sem_t *sem, int pshared, unsigned int value) {
	(void)pshared;
	*(volatile unsigned int *)sem = value;
	return 0;
}
int sem_destroy(sem_t *sem) {
	(void)sem;
	return 0;
}
int sem_post(sem_t *sem) {
	__atomic_fetch_add((unsigned int *)sem, 1u, __ATOMIC_SEQ_CST);
	return 0;
}
int sem_trywait(sem_t *sem) {
	unsigned int value = __atomic_load_n((unsigned int *)sem, __ATOMIC_SEQ_CST);
	while (value > 0) {
		if (__atomic_compare_exchange_n((unsigned int *)sem, &value, value - 1, 0,
				__ATOMIC_SEQ_CST, __ATOMIC_SEQ_CST)) {
			return 0;
		}
	}
	return -1;
}
int sem_wait(sem_t *sem) {
	unsigned int value = __atomic_load_n((unsigned int *)sem, __ATOMIC_SEQ_CST);
	while (value > 0) {
		if (__atomic_compare_exchange_n((unsigned int *)sem, &value, value - 1, 0,
				__ATOMIC_SEQ_CST, __ATOMIC_SEQ_CST)) {
			return 0;
		}
	}
	// Nothing to take. With no other thread, the post that would have made this block has already
	// happened, so succeeding is what keeps it from deadlocking.
	return 0;
}
int sem_timedwait(sem_t *sem, const struct timespec *abs_timeout) {
	(void)abs_timeout;
	return sem_wait(sem);
}
int sem_getvalue(sem_t *sem, int *sval) {
	*sval = (int)__atomic_load_n((unsigned int *)sem, __ATOMIC_SEQ_CST);
	return 0;
}
`;

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
