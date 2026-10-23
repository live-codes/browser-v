// The backends this package can drive, and what each one means.
//
// `wasm` is the whole pipeline: V to C, C to WebAssembly, and a run. `c` stops at the generated C and
// hands it back instead, which is what a caller that wants to read or take away the C asks for — and it
// never loads the ~29 MB Clang toolchain, because nothing needs compiling.
//
// Unlike `@live-codes/clang-wasm`, there is one language here rather than a family, so which backend to
// use is an option rather than the first positional argument.
export const TARGETS = Object.freeze({
	WASM: 'wasm',
	C: 'c'
});

const ALIASES = new Map([
	['wasm', TARGETS.WASM],
	['v-wasm', TARGETS.WASM],
	['browser', TARGETS.WASM],
	['c', TARGETS.C],
	['v-c', TARGETS.C],
	['source', TARGETS.C],
	['c-source', TARGETS.C]
]);

/** Resolve a target, with the aliases a caller might reasonably reach for. */
export function resolveTarget(value) {
	const id = ALIASES.get(String(value ?? '').trim().toLowerCase());
	if (!id) {
		throw new Error(
			`Unknown target ${JSON.stringify(value)}. Expected one of: ${Object.values(TARGETS).join(', ')}.`
		);
	}
	return id;
}

export const DEFAULT_TARGET = TARGETS.WASM;

