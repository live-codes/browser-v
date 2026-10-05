// Loading the V compiler in Node, where there is no global scope to publish `createVCompiler` into.
//
// The bundle is a classic Emscripten script with Node support compiled in, so it is evaluated in a vm
// context: its top-level declarations land on that context, and its CommonJS tail writes the module
// factory to `module.exports`. Because the package reads the assets itself, `v.wasm` is handed over
// through `Module.instantiateWasm` - this build never reads `Module.wasmBinary`, and its Node path
// would otherwise try to open the file off disk - which is also what lets every asset be checked
// against its pinned receipt before it is used.
//
// Only reachable through the `node` condition in package.json, so a browser bundle never includes it.
import { createRequire } from 'node:module';
import vm from 'node:vm';

import { createCompilerCore } from './v-compile.js';

const compilers = new Map();

export function loadVCompiler({ source, onStatus = () => {} }) {
	if (!compilers.has(source.key)) {
		const pending = loadInNode({ source, onStatus }).catch((error) => {
			compilers.delete(source.key);
			throw error;
		});
		compilers.set(source.key, pending);
	}
	return compilers.get(source.key);
}

async function loadInNode({ source, onStatus }) {
	const [bundleBytes, wasmBytes, tarBytes] = await Promise.all([
		source.readAsset('v.js'),
		source.readAsset('v.wasm'),
		source.readAsset('vlib.tar')
	]);
	const bundleText = new TextDecoder('utf-8', { fatal: true }).decode(bundleBytes);

	// The compiler reports on its own output as it runs, and whoever asked for this compile is the one
	// who wants it. A buffer rather than a callback, because the loaded compiler is cached per asset
	// source and shared: a callback baked in at load would belong to whoever asked first.
	const output = [];

	// Everything the bundle reaches for that a Node global does not already provide. `require` is the
	// interesting one: Emscripten's Node branch uses it to load `fs`/`path` for its own bootstrapping,
	// even though it never reads `v.wasm` from disk here because it was handed the bytes.
	const module_ = { exports: {} };
	const context = vm.createContext(
		Object.assign(Object.create(null), {
			module: module_,
			exports: module_.exports,
			require: createRequire(import.meta.url),
			// Only used by the bundle to build script paths, which nothing fetches here.
			__dirname: process.cwd(),
			__filename: 'v.js',
			console,
			process,
			Buffer,
			URL,
			URLSearchParams,
			TextEncoder,
			TextDecoder,
			WebAssembly,
			performance,
			setTimeout,
			clearTimeout,
			setInterval,
			clearInterval,
			queueMicrotask,
			crypto: globalThis.crypto,
			atob: globalThis.atob,
			btoa: globalThis.btoa,
			fetch: globalThis.fetch,
			structuredClone: globalThis.structuredClone,
			AbortController: globalThis.AbortController
		})
	);

	onStatus('loading the V compiler…');
	vm.runInContext(bundleText, context, { filename: 'v.js' });

	const factory = module_.exports?.default ?? module_.exports ?? context.createVCompiler;
	if (typeof factory !== 'function') {
		throw new Error('The V compiler bundle did not define `createVCompiler`.');
	}

	// This build instantiates through `Module.instantiateWasm` rather than `Module.wasmBinary`; without
	// it Emscripten falls back to reading `v.wasm` off disk, which is not where it is.
	const wasmModule = new WebAssembly.Module(wasmBytes);

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
	core.loadVlib(new Uint8Array(tarBytes));

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
