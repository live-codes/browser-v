/*
 * Making the V compiler work where there are no threads or semaphores.
 *
 * V's compiler uses `spawn` in a few places: to prepare the markused/transform
 * indexes while the checker runs, and for its parallel-checker worker pool. Its
 * generated C funnels all of that through pthread_create/pthread_join, and its
 * sync module implements Semaphore over the POSIX sem_* calls. Both sets are
 * thin wrappers we intercept at link time (see the -Wl,--wrap flags in
 * build-v-wasm.sh).
 *
 * Emscripten's wasm32 sysroot has neither working pthreads nor working anonymous
 * semaphores: providing them would mean SharedArrayBuffer and cross-origin
 * isolation, a requirement the playground should not impose. So instead:
 *
 *   - __wrap_pthread_create runs the thread body immediately and remembers its
 *     result for the matching join, which makes `spawn` a synchronous call.
 *   - __wrap_sem_* implement the semaphore as a plain counter that never blocks.
 *
 * Both are only sound because the compiler is invoked with `-no-parallel`: that
 * turns off the worker pool, where threads coordinate over channels and would
 * deadlock if run one after another. What is left are self-contained "compute
 * this now, hand me the result" calls, which lose only their overlap, not their
 * meaning. With every thread body running to completion inside spawn, a post()
 * always happens before the wait() that observes it, so never blocking is
 * correct rather than merely convenient.
 */
#include <errno.h>
#include <pthread.h>
#include <semaphore.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <time.h>

#if defined(V_STUB_DEBUG)
static int v_dbg_threads = 0;
static long v_dbg_sem_wait = 0;
static long v_dbg_sem_trywait = 0;
#define V_DBG(...) \
	do { \
		fprintf(stderr, __VA_ARGS__); \
		fflush(stderr); \
	} while (0)
#else
#define V_DBG(...)
#endif

typedef struct {
	void *result;
} VSyncThreadSlot;

static VSyncThreadSlot *v_sync_slots = NULL;
static size_t v_sync_capacity = 0;
static size_t v_sync_count = 0;

static int v_sync_reserve(void) {
	if (v_sync_count < v_sync_capacity) {
		return 0;
	}
	size_t capacity = v_sync_capacity == 0 ? 64 : v_sync_capacity * 2;
	VSyncThreadSlot *grown = (VSyncThreadSlot *)realloc(v_sync_slots, capacity * sizeof(VSyncThreadSlot));
	if (grown == NULL) {
		return EAGAIN;
	}
	v_sync_slots = grown;
	v_sync_capacity = capacity;
	return 0;
}

int __wrap_pthread_create(pthread_t *thread, const pthread_attr_t *attr,
	void *(*start_routine)(void *), void *arg) {
	(void)attr;
	V_DBG("[stub] thread create %p\n", (void *)(uintptr_t)start_routine);
	if (v_sync_reserve() != 0) {
		return EAGAIN;
	}
	size_t id = v_sync_count++;
	v_sync_slots[id].result = start_routine(arg);
	V_DBG("[stub] thread %d finished, result %p\n", (int)id, v_sync_slots[id].result);
	/* Hand back a unique, non-zero handle so thread equality still tells
	 * distinct threads apart. */
	*thread = (pthread_t)(id + 1);
	return 0;
}

int __wrap_pthread_join(pthread_t thread, void **retval) {
	size_t id = (size_t)thread;
	if (retval != NULL) {
		*retval = (id >= 1 && id <= v_sync_count) ? v_sync_slots[id - 1].result : NULL;
	}
	return 0;
}

/* The counter lives in the first bytes of the sem_t the caller allocated; every
 * implementation here writes only that, same as libc would. */

int __wrap_sem_init(sem_t *sem, int pshared, unsigned int value) {
	(void)pshared;
	*(volatile unsigned int *)sem = value;
	return 0;
}

int __wrap_sem_destroy(sem_t *sem) {
	(void)sem;
	return 0;
}

int __wrap_sem_post(sem_t *sem) {
	__atomic_fetch_add((unsigned int *)sem, 1u, __ATOMIC_SEQ_CST);
	return 0;
}

int __wrap_sem_trywait(sem_t *sem) {
	unsigned int value = __atomic_load_n((unsigned int *)sem, __ATOMIC_SEQ_CST);
#if defined(V_STUB_DEBUG)
	long n = ++v_dbg_sem_trywait;
	if (n <= 30 || n % 200000 == 0) V_DBG("[stub] sem_trywait #%ld value=%u\n", n, value);
#endif
	while (value > 0) {
		if (__atomic_compare_exchange_n((unsigned int *)sem, &value, value - 1, 0,
				__ATOMIC_SEQ_CST, __ATOMIC_SEQ_CST)) {
			return 0;
		}
	}
	errno = EAGAIN;
	return -1;
}

int __wrap_sem_wait(sem_t *sem) {
	unsigned int value = __atomic_load_n((unsigned int *)sem, __ATOMIC_SEQ_CST);
#if defined(V_STUB_DEBUG)
	long n = ++v_dbg_sem_wait;
	if (n <= 30 || n % 200000 == 0) V_DBG("[stub] sem_wait #%ld value=%u\n", n, value);
#endif
	while (value > 0) {
		if (__atomic_compare_exchange_n((unsigned int *)sem, &value, value - 1, 0,
				__ATOMIC_SEQ_CST, __ATOMIC_SEQ_CST)) {
			return 0;
		}
	}
	/* Nothing to take. With synchronous threads the post that would have made
	 * this block has already happened, so succeed rather than deadlock. */
	return 0;
}

int __wrap_sem_timedwait(sem_t *sem, const struct timespec *abs_timeout) {
	(void)abs_timeout;
	return __wrap_sem_wait(sem);
}
