// Step 2 of the pipeline: V's generated C -> one wasm module -> a run.
//
// This goes through `@live-codes/clang-wasm`'s low-level entry rather than the Clang runtime directly.
// `createToolchain` is that runtime with the four-language policy taken out, which is exactly what a
// driver for a language that merely *compiles through* Clang needs: the runtime, its lock, `addFile`,
// `captureCompilerOutput` and `execute`, and nothing else.
//
// Going through the package buys two things beyond not depending on someone else's internals:
//
//  - **One runtime, shared.** The toolchain is acquired from the same pool `createCompiler` uses,
//    keyed by asset source, so a page running C/C++ alongside V pays for one runtime and one asset
//    load - and shares its lock, so the two cannot write over each other's files or redirect each
//    other's output.
//  - **One place that knows the flags.** `CLANG_DRIVER_DEFAULT_ARGS` is the package's own list of
//    what a driver's clang invocation needs, and why. Copying that list here would be a copy that
//    drifts.
import {
	CLANG_DRIVER_DEFAULT_ARGS,
	compilerDiagnostics,
	createToolchain
} from '@live-codes/clang-wasm/toolchain';

import { makeStdin } from './output.js';
import { COMPILE_ARGS, SHIMS, SOURCE_PATCHES, SOURCE_SUFFIX } from './shims.js';

// Third-party C that the V standard library calls into but does not embed in the generated C. V's own
// build hands these `.c` files to the C compiler as separate translation units; the toolchain entry this
// package uses has no multi-file form, so the source is appended to the same translation unit, with the
// header mounted so the generated `#include` resolves. Only the ones a program actually asks for are
// added, so a program that does not use the module pays nothing.
const THIRD_PARTY = {
	'cJSON.h': {
		header: '/v/thirdparty/cJSON/cJSON.h',
		source: '/v/thirdparty/cJSON/cJSON.c',
		unit: 'cJSON.c'
	}
};

const toolchains = new Map();

/**
 * Acquire the shared Clang toolchain, once per asset URL.
 *
 * The toolchain holds a reference on the shared runtime and is kept for the life of the thread: the
 * runtime costs ~29 MB of assets and ~84 MB resident, and keeping it is what makes a warm compile
 * ~100 ms instead of ~3 s. Nothing disposes it, because the only thing that ends it here is the worker
 * being terminated, which takes the whole runtime with it.
 */
export function loadClangToolchain({ baseUrl, onProgress }) {
	const key = String(baseUrl);
	if (!toolchains.has(key)) {
		const pending = createToolchain({ baseUrl, onProgress }).catch((error) => {
			// A failed load must not poison the cache, or a retry can never succeed.
			toolchains.delete(key);
			throw error;
		});
		toolchains.set(key, pending);
	}
	return toolchains.get(key);
}

const shimmed = new WeakSet();

/** Put the handful of headers and the `getpid()` patch where clang will find them. */
const mountShims = (toolchain) => {
	if (shimmed.has(toolchain)) return;
	for (const path of Object.keys(SHIMS)) {
		toolchain.addFile(path, SHIMS[path]);
	}
	shimmed.add(toolchain);
};

// The absolute includes V's generated C names, already mounted, per toolchain. The files are the
// compiler's own and static, so a path only has to be written once.
const mountedIncludes = new WeakMap();

// Third-party headers already mounted, per toolchain, for the same reason.
const mountedThirdParty = new WeakMap();

const ABSOLUTE_INCLUDE = /#include\s+"(\/[^"]+)"/g;

/**
 * Append the third-party source the generated C asks for, and mount its header.
 *
 * A unit is only added when something in the C names its header, so a program that does not import the
 * module gets neither the code nor the symbols. The files are read from the compiler's filesystem, which
 * is where `vlib.tar` unpacks V's own `thirdparty/` tree.
 *
 * @returns {Array<{path: string, content: string}>} workspace files to compile and link alongside
 *   the generated C, empty when nothing is needed.
 */
const collectThirdParty = (toolchain, cSource, readInclude) => {
	let seen = mountedThirdParty.get(toolchain);
	if (!seen) {
		seen = new Set();
		mountedThirdParty.set(toolchain, seen);
	}

	const units = [];
	for (const [header, files] of Object.entries(THIRD_PARTY)) {
		// Either spelling: V emits `#include "cJSON.h"` when the header is not in its own tree, and
		// `#include "/v/thirdparty/cJSON/cJSON.h"` once it is (so a build of this package with cJSON
		// packed produces the absolute form). Both mean the same unit is needed.
		if (!cSource.includes(header) || seen.has(header)) continue;
		try {
			// The unit includes its own header by name, so it has to be on the include path as well as
			// being what the generated absolute include is resolved to.
			toolchain.addFile(header, readInclude(files.header));
			units.push({ path: files.unit, content: readInclude(files.source) });
			seen.add(header);
		} catch {
			// The compiler's tree does not carry this library; the compile will report the missing
			// header itself, which is a clearer failure than one of ours.
		}
	}
	return units;
};

/**
 * Copy the files V's generated C includes by absolute path into the toolchain's filesystem.
 *
 * The compiler was built with its root at `/v`, so the C says `#include "/v/vlib/builtin/..."`. The
 * toolchain's filesystem is a different one, so those files are copied across from the compiler's,
 * which already has the whole tree. Follows nested includes: a header copied in can name another.
 */
const mountAbsoluteIncludes = (toolchain, cSource, readInclude) => {
	let seen = mountedIncludes.get(toolchain);
	if (!seen) {
		seen = new Set();
		mountedIncludes.set(toolchain, seen);
	}

	const queue = [];
	const scan = (text) => {
		let match;
		ABSOLUTE_INCLUDE.lastIndex = 0;
		while ((match = ABSOLUTE_INCLUDE.exec(text)) !== null) {
			if (!seen.has(match[1])) {
				seen.add(match[1]);
				queue.push(match[1]);
			}
		}
	};

	scan(cSource);
	while (queue.length > 0) {
		const absolute = queue.shift();
		let text;
		try {
			text = readInclude(absolute);
		} catch {
			continue;
		}
		// memfs paths are relative to its root, so drop the leading slash.
		toolchain.addFile(absolute.replace(/^\//, ''), text);
		scan(text);
	}
};

/**
 * Compile the generated C and link it into one wasm module.
 *
 * @param {object} toolchain
 * @param {object} options
 * @param {string} options.cSource
 * @param {(path: string) => string} options.readInclude - read one of the compiler's own files.
 * @param {string[]} [options.compileArgs] - extra clang flags.
 * @param {(raw: string) => void} [options.onCompilerOutput] - clang's and wasm-ld's output as it
 *   arrived, for a build log. It is the same stream `compilerDiagnostics` filters.
 * @throws if clang or the linker failed, carrying their diagnostics as the message.
 */
export async function compileVSource(
	toolchain,
	{ cSource, readInclude, compileArgs = [], onCompilerOutput = () => {} }
) {
	// The lock is held for the whole build. The runtime owns one compiler process and one filesystem,
	// so a second build starting now would write over this one's files.
	return toolchain.lock(async () => {
		mountShims(toolchain);
		mountAbsoluteIncludes(toolchain, cSource, readInclude);
		const workspaceFiles = collectThirdParty(toolchain, cSource, readInclude);

		const { result, raw, error } = await toolchain.captureCompilerOutput(() =>
			toolchain.runtime.compileArtifact(SOURCE_PATCHES + cSource + SOURCE_SUFFIX, {
				language: 'C',
				fileName: 'main.c',
				workspaceFiles,
				compileArgs: [...CLANG_DRIVER_DEFAULT_ARGS, ...COMPILE_ARGS, ...compileArgs]
			})
		);

		onCompilerOutput(raw);

		if (error) {
			// What clang or the linker said is the only useful part of a failure - a bare "process
			// exited with code 1" tells a reader nothing. `compilerDiagnostics` drops the runtime's own
			// chatter first, so the message is the compiler's words and nothing else.
			const diagnostics = compilerDiagnostics(raw);
			throw new Error(diagnostics.length ? diagnostics.join('\n') : String(error?.message ?? error));
		}
		return result;
	});
}

export const runArtifact = (
	toolchain,
	artifact,
	{ args = [], stdin, onStdout = () => {}, onStderr = () => {} }
) =>
	toolchain.execute(artifact, {
		args,
		stdin: makeStdin(stdin),
		stdout: onStdout,
		stderr: onStderr
	});
