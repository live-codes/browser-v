// What this package ships, pinned, and where it came from.
//
// Unlike the sibling `@live-codes/nim-wasm`, these files are not a third-party prebuilt: the V
// compiler and its standard library are built from a pinned V commit by this repository's own
// pipeline (`build/build-v-wasm.sh`, run inside the `build/Dockerfile` container), which writes the
// same SHA-256s into `receipt.json`. The pin here is what that build produced, so a read can check
// the bytes are the ones it records rather than trusting the host they came from.
//
//   v.js          the Emscripten loader for the compiler
//   v.wasm.gz     the V 0.5.2 compiler, compiled to wasm32 and gzipped
//   vlib.tar.gz   the V standard library the compiler compiles against, packed and gzipped
//
// The two large assets are shipped gzipped rather than raw and inflated in JavaScript, so a host that
// does no transfer compression of its own - a plain static server, say - still sends about 9 MB
// instead of about 32. `docs/ASSETS.md` records how they are produced and how to re-pin them.
export const ASSET_SOURCE = Object.freeze({
	kind: 'built-from-source by this repository',
	v_commit: 'e1ec613778753bfe9cd35f9178d472a9def890bf',
	compiler: {
		name: 'v',
		version: '0.5.2',
		host: 'Emscripten, wasm32_emscripten',
		builtBy: 'build/build-v-wasm.sh',
		// The linked module is post-optimized with binaryen; see the pipeline.
		wasmOpt: '-O2 --strip-debug'
	},
	pipeline: 'build/Dockerfile',
	license: 'MIT, for V and its standard library'
});

export const ASSET_RECEIPTS = Object.freeze({
	'v.js': {
		bytes: 160281,
		sha256: '19145c46e3ca22bd3724de4f726b27a03ed208f5eef435198888558b3ca940ee'
	},
	'v.wasm.gz': {
		bytes: 5215867,
		sha256: '1ab62a9ce0e6aceb7b1545b4ea845b22fca3cd46664f5af78e9bbb13a8ab8a6f'
	},
	'vlib.tar.gz': {
		bytes: 3374702,
		sha256: '49726a825454d5673f93f4bccf413a6c704a839a08e534b0e32eeb783c986e2f'
	}
});
