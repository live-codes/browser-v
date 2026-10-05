// Driving the V compiler, once it has been loaded.
//
// Split from the loading because the two environments load it differently - a script tag or
// `importScripts` in a browser, a vm context in Node - and everything below is the same either way.

const V_SOURCE_PATH = '/main.v';
const V_C_PATH = '/main.c';

// The compiler's own root. `vlib.tar` unpacks here and the generated C includes its own files by
// absolute path from here (`#include "/v/vlib/builtin/..."`), because the compiler was built with its
// root at `/v`.
export const V_ROOT = '/v';

// V 0.5.2 has a native WebAssembly code generator, but it covers very little and reports what it
// cannot handle as warnings while printing the wrong answer, so the browser-capable route is C for
// wasm32_emscripten.
//
//   -gc none      the target otherwise asks for the Boehm GC, whose <gc.h> does not exist here, and
//                 short playground programs do not need a collector.
//   -no-parallel  what the synchronous pthread/semaphore stubs the compiler is built with rely on.
//   -new-compiler what makes V show its own diagnostics instead of quietly handing the compile to a
//                 second compiler.
export const V_COMPILE_ARGS = Object.freeze([
	'-new-compiler',
	'-b',
	'c',
	'-os',
	'wasm32_emscripten',
	'-no-parallel',
	'-gc',
	'none',
	'-o',
	V_C_PATH,
	V_SOURCE_PATH
]);

// Extra flags have to land before the source path, since V treats options after it as the program's
// own arguments.
//
// A fresh array every time, never the frozen `V_COMPILE_ARGS`: `callMain` unshifts the program's name
// into the array it is given, and a frozen array cannot be extended.
const withFlags = (args, extra) => {
	const at = args.indexOf(V_SOURCE_PATH);
	return [...args.slice(0, at), ...extra, ...args.slice(at)];
};

/**
 * Unpack a plain ustar archive into an Emscripten filesystem.
 *
 * A minimal reader rather than a dependency: the archive is written by `tar` in the build pipeline
 * and only ever holds files and directories.
 */
export function extractTar(bytes, FS, base) {
	const decoder = new TextDecoder();
	const readString = (start, length) => {
		let end = start;
		while (end < start + length && bytes[end] !== 0) end++;
		return decoder.decode(bytes.subarray(start, end));
	};

	const files = [];
	let offset = 0;
	while (offset + 512 <= bytes.length) {
		const empty = bytes.subarray(offset, offset + 512).every((byte) => byte === 0);
		if (empty) break;

		const prefix = readString(offset + 345, 155);
		const name = readString(offset, 100);
		const pathName = (prefix ? `${prefix}/${name}` : name).replace(/^\/+/, '');
		const size = Number.parseInt(readString(offset + 124, 12).trim(), 8) || 0;
		const type = bytes[offset + 156] === 0 ? '0' : String.fromCharCode(bytes[offset + 156]);
		const dataStart = offset + 512;
		const target = base + pathName;

		if (type === '5') {
			FS.mkdirTree(target);
		} else if (type === '0') {
			files.push([target, bytes.subarray(dataStart, dataStart + size)]);
		}
		offset = dataStart + Math.ceil(size / 512) * 512;
	}

	for (const [target, data] of files) {
		const dir = target.slice(0, target.lastIndexOf('/'));
		if (dir) FS.mkdirTree(dir);
		FS.writeFile(target, data);
	}
}

/**
 * The compiler's entry point, over a loaded Emscripten runtime.
 *
 * Extra flags are per call rather than per compiler, because the loaded compiler is cached per asset
 * source and shared: anything baked in here would belong to whoever asked first.
 *
 * @param {object} runtime
 * @param {object} runtime.FS - the compiler's Emscripten filesystem.
 * @param {Function} runtime.callMain - the compiler entry point.
 */
export function createCompilerCore({ FS, callMain }) {
	const readText = (path) => FS.readFile(path, { encoding: 'utf8' });

	return {
		/**
		 * Unpack the standard library the compiler compiles against. Done once, at load, because the
		 * compiler holds it in its filesystem for the life of the thread.
		 */
		loadVlib(tarBytes) {
			FS.mkdirTree(V_ROOT);
			FS.mkdirTree('/tmp');
			extractTar(tarBytes, FS, `${V_ROOT}/`);
		},

		/** Compile a program to the C the backend emitted, or fail with the compiler's exit code. */
		compileToC(source, compileArgs = []) {
			FS.writeFile(V_SOURCE_PATH, source);
			// A failed compile must not be mistaken for the previous successful one.
			try {
				FS.unlink(V_C_PATH);
			} catch {
				// Nothing there from a previous run.
			}

			let exitCode = 1;
			try {
				exitCode = callMain(withFlags(V_COMPILE_ARGS, compileArgs));
			} catch (error) {
				// Emscripten throws for an abort rather than returning a status. The compiler's own
				// words are already in its output, which the caller collects.
				exitCode = typeof error?.status === 'number' ? error.status : 1;
			}

			let cSource = '';
			try {
				cSource = readText(V_C_PATH);
			} catch {
				// Left empty; `ok` is false and the caller reports the diagnostics.
			}

			// Both, because a successful compile that emitted nothing is still a failure here.
			return { cSource, exitCode, ok: exitCode === 0 && cSource.length > 0 };
		},

		/** The generated C includes a few of the compiler's own files by absolute path. */
		readFile: (path) => readText(path),

		hasFile(path) {
			try {
				FS.readFile(path);
				return true;
			} catch {
				return false;
			}
		}
	};
}
