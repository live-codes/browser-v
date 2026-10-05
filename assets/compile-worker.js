/*
 * Runs the whole pipeline off the page's thread, through the `@live-codes/v-wasm` package:
 *
 *   your V  ->  V compiler in wasm  ->  main.c  ->  Clang/LLD in wasm  ->  run
 *
 * Both the compiler and the toolchain block whichever thread hosts them and take seconds, so they live
 * here; the page stays responsive and a stuck compile can be cancelled by discarding the worker.
 *
 * The package is loaded as its classic-script (IIFE) build, which is why this has to be a classic
 * worker: the V compiler's Emscripten bundle decides it is in a worker by finding `importScripts`, and a
 * module worker does not have it.
 *
 * Protocol: post { type: 'compile', source }; receive
 *   { type: 'ready' }                            the compiler is loaded
 *   { type: 'status', text }                     what is happening now
 *   { type: 'result', output, exitCode, log }    the program ran
 *   { type: 'failed', errors, log }              the compilers' diagnostics
 */
const packageBase = new URL('../packages/v-wasm/', self.location.href).href;
importScripts(packageBase + 'dist/v-wasm.global.js');

let log = '';
let compilerPromise = null;

function getCompiler() {
	if (!compilerPromise) {
		compilerPromise = self.vWasm
			.createCompiler({
				baseUrl: packageBase + 'assets/v/',
				clangBaseUrl: new URL('../assets/clang/', self.location.href).href,
				onStatus: (text) => self.postMessage({ type: 'status', text }),
				onLog: (text) => {
					log += text;
				}
			})
			.catch((error) => {
				// A failed load must not poison the cache, or a retry can never succeed.
				compilerPromise = null;
				throw error;
			});
	}
	return compilerPromise;
}

self.addEventListener('message', async (event) => {
	const { type, source } = event.data || {};
	if (type !== 'compile') return;

	log = '';
	try {
		const compiler = await getCompiler();
		const result = await compiler.run(source);

		if (result.errors.length > 0) {
			self.postMessage({ type: 'failed', errors: result.errors, log });
			return;
		}
		self.postMessage({
			type: 'result',
			output: result.output,
			exitCode: result.exitCode,
			log
		});
	} catch (error) {
		self.postMessage({ type: 'failed', errors: [String(error?.message ?? error)], log });
	}
});

getCompiler()
	.then(() => self.postMessage({ type: 'ready' }))
	.catch((error) =>
		self.postMessage({ type: 'failed', errors: [String(error?.message ?? error)], log: '' })
	);
