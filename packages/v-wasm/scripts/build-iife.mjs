// Builds the IIFE bundle: one classic script, for workers and pages that cannot use ES modules.
//
//   npm run build:iife
//
// The output is committed, because a classic worker can only `importScripts()` a URL and a consumer
// should not need a bundler to get one. It is built from the browser entry, so it carries none of the
// Node-only packaged-assets code.
import { build } from 'esbuild';
import { statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const outfile = fileURLToPath(new URL('../dist/v-wasm.global.js', import.meta.url));

await build({
	entryPoints: [fileURLToPath(new URL('../src/index.js', import.meta.url))],
	outfile,
	bundle: true,
	format: 'iife',
	globalName: 'vWasm',
	minify: true,
	platform: 'browser',
	target: 'es2022',
	// Keeps any third-party @license comments in a sidecar rather than in the payload.
	legalComments: 'external',
	banner: {
		js: `/*! @live-codes/v-wasm - MIT. IIFE build, sets self.vWasm.
 *  importScripts('v-wasm.global.js') then self.vWasm.createCompiler({ baseUrl, clangBaseUrl }).
 *  The V compiler is not bundled: it is fetched from baseUrl at runtime. This does bundle the Clang
 *  toolchain, through @live-codes/clang-wasm (MIT) - and so @wasm-idle/llvm-core (MIT AND Apache-2.0
 *  WITH LLVM-exception), @bjorn3/browser_wasi_shim (MIT OR Apache-2.0) and fflate (MIT) with it. */`
	}
});

console.log(`dist/v-wasm.global.js  ${(statSync(outfile).size / 1024).toFixed(1)} KB (minified)`);
