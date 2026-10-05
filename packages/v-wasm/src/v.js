// Loading the V compiler where there is a document or a worker global: the browser entry's half.
//
// The bundle is a classic Emscripten script, so it has to be evaluated in the global scope of
// whichever thread it runs on - top-level `var`/`function` declarations are what publish
// `createVCompiler`, and neither an ES module nor a wrapped function would do that. On a page that
// means a script tag; in a worker it means `importScripts`.
//
// `importScripts` is also the test for which one to use, rather than `document`. The Clang runtime
// installs a `document` stub on the global scope so its own code can run in a worker
// (`globalThis.document = { querySelectorAll }`), which leaves `typeof document` saying `object`
// there, with no `createElement` on it.
//
// That stub is why the worker has to be a classic worker: the bundle decides it is in a worker by
// looking for `importScripts`, which module workers do not have, and without it it initialises for no
// environment at all.
import { inflateGzip } from './inflate.js';
import { createCompilerCore } from './v-compile.js';

const loadScript = (src) => {
	if (typeof importScripts === 'function') {
		try {
			importScripts(src);
			return Promise.resolve();
		} catch (error) {
			return Promise.reject(new Error(`Failed to load ${src}: ${error?.message ?? error}`));
		}
	}
	return new Promise((resolve, reject) => {
		const script = document.createElement('script');
		script.src = src;
		script.onload = () => resolve();
		script.onerror = () => reject(new Error(`Failed to load ${src}`));
		document.head.appendChild(script);
	});
};

const compilers = new Map();

/**
 * Load the compiler once per asset source and keep it: it holds the standard library in its memory
 * filesystem, so a warm compiler is the difference between a compile and a recompile.
 *
 * @param {object} options
 * @param {object} options.source - from `resolveAssetSource`. The browser's is a hosted one.
 * @param {(text: string) => void} [options.onStatus]
 */
export function loadVCompiler({ source, onStatus = () => {} }) {
	if (!compilers.has(source.key)) {
		const pending = loadInBrowser({ source, onStatus }).catch((error) => {
			// A failed load must not poison the cache, or a retry can never succeed.
			compilers.delete(source.key);
			throw error;
		});
		compilers.set(source.key, pending);
	}
	return compilers.get(source.key);
}

async function loadInBrowser({ source, onStatus }) {
	// Both large assets are fetched here - and checked against their pins - rather than by Emscripten.
	// They ship gzipped, so they are inflated here too; see `inflate.js` for why.
	const [wasmGzip, vlibGzip] = await Promise.all([
		source.readAsset('v.wasm.gz'),
		source.readAsset('vlib.tar.gz')
	]);
	const [wasmBytes, vlibBytes] = await Promise.all([inflateGzip(wasmGzip), inflateGzip(vlibGzip)]);

	// Compiled here rather than by Emscripten, so `v.wasm.gz` never has to exist as a plain `v.wasm`
	// on the host, and so the bytes are the ones this package verified.
	const wasmModule = await WebAssembly.compile(wasmBytes);

	// The compiler reports on its own output as it runs, and whoever asked for this compile is the one
	// who wants it. A buffer rather than a callback, because the loaded compiler is cached per asset
	// source and shared: a callback baked in at load would belong to whoever asked first.
	const output = [];

	onStatus('loading the V compiler…');
	await loadScript(source.bundleUrl);

	const factory = globalThis.createVCompiler;
	if (typeof factory !== 'function') {
		throw new Error('The V compiler bundle did not define `createVCompiler`.');
	}

	const compiler = await factory({
		instantiateWasm: (imports, success) => {
			const instance = new WebAssembly.Instance(wasmModule, imports);
			success(instance, wasmModule);
			return instance.exports;
		},
		print: (text) => output.push(text),
		printErr: (text) => output.push(text)
	});

	const core = createCompilerCore({ FS: compiler.FS, callMain: compiler.callMain });
	core.loadVlib(vlibBytes);

	return {
		...core,
		/** The compiler's output since the last call, which is where its diagnostics are. */
		takeOutput() {
			const text = output.join('');
			output.length = 0;
			return text;
		}
	};
}
