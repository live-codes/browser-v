// What this package ships, pinned, and where it came from.
//
// Unlike the sibling `@live-codes/nim-wasm`, these three files are not a third-party prebuilt: the V
// compiler and its standard library are built from a pinned V commit by this repository's own
// pipeline (`build/build-v-wasm.sh`, run inside the `build/Dockerfile` container), and the build
// writes the same SHA-256s into `assets/receipt.json`. The pin here is what that build produced, so a
// read can check the bytes are the ones it records rather than trusting the host they came from.
//
//   v.js       the Emscripten loader for the compiler
//   v.wasm     the V 0.5.2 compiler, compiled from C to wasm32
//   vlib.tar   the V standard library the compiler compiles against, packed
//
// `docs/ASSETS.md` records how they are produced and how to re-pin them.
export const ASSET_SOURCE = Object.freeze({
	kind: 'built-from-source by this repository',
	v_commit: 'e1ec613778753bfe9cd35f9178d472a9def890bf',
	compiler: {
		name: 'v',
		version: '0.5.2',
		host: 'Emscripten, wasm32_emscripten',
		builtBy: 'build/build-v-wasm.sh'
	},
	pipeline: 'build/Dockerfile',
	license: 'MIT, for V and its standard library'
});

export const ASSET_RECEIPTS = Object.freeze({
	'v.js': {
		bytes: 160281,
		sha256: '19145c46e3ca22bd3724de4f726b27a03ed208f5eef435198888558b3ca940ee'
	},
	'v.wasm': {
		bytes: 18062354,
		sha256: 'ecadd07f247d928db47e027126ef2b352ca823347a3e330e1d06a0b264eca106'
	},
	'vlib.tar': {
		bytes: 14745600,
		sha256: '84fb3b1348be3616d8972c644a9a7e3b99a30713bee62036a2bc3d135face408'
	}
});
