// Where the compiler's assets come from, and how they are read.
//
// Two sources behind one shape, because everything downstream only needs "what URL is the loader at",
// "where is anything else" and "give me this file":
//
//   hosted   - a base URL. The loader is evaluated from there and Emscripten fetches `v.wasm` from
//              there itself, so those two are only as good as the host they are served from.
//              `vlib.tar` is fetched here, and therefore checked.
//   packaged - the assets that ship inside this package, on disk. Only reachable through the `node`
//              condition, because a browser cannot read a file inside an npm package. Everything is
//              read here, so everything is checked.
import { ASSET_RECEIPTS, ASSET_SOURCE } from './asset-receipts.js';

/** sha256 of some bytes, as hex, using whatever the platform provides. */
export async function sha256Hex(bytes) {
	const subtle = globalThis.crypto?.subtle;
	if (!subtle) {
		throw new Error(
			'Verifying the compiler assets needs crypto.subtle: a secure context in the browser, or ' +
				'Node 20 and later.'
		);
	}
	const digest = await subtle.digest('SHA-256', bytes);
	return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * Check bytes against the pinned receipt for that asset.
 *
 * @param {string} name - the asset's name in `ASSET_RECEIPTS`.
 * @param {Uint8Array} bytes
 */
export async function verifyReceipt(name, bytes) {
	const receipt = ASSET_RECEIPTS[name];
	if (!receipt) throw new Error(`No pinned receipt for the compiler asset ${name}`);
	if (bytes.byteLength !== receipt.bytes) {
		throw new Error(
			`The compiler asset ${name} is ${bytes.byteLength} bytes, expected ${receipt.bytes}`
		);
	}
	const digest = await sha256Hex(bytes);
	if (digest !== receipt.sha256) {
		throw new Error(
			`The compiler asset ${name} failed SHA-256 verification: expected ${receipt.sha256}, got ${digest}`
		);
	}
	return bytes;
}

/**
 * Resolve how to reach the assets.
 *
 * @param {object} options - the caller's options; `baseUrl` is what decides.
 * @param {object|null} packaged - the on-disk source, or null where there is no filesystem.
 */
export function resolveAssetSource(options, packaged) {
	if (options.baseUrl != null && options.baseUrl !== '') return createHostedSource(options);
	if (!packaged) {
		throw new Error(
			'baseUrl is required here. The assets that ship in this package can only be read where there ' +
				'is a filesystem, and a browser cannot reach a file inside an npm package - copy them ' +
				'somewhere your page can fetch with `npx --package @live-codes/v-wasm ' +
				'v-wasm-copy-assets <dir>` and pass that directory as baseUrl.'
		);
	}
	return createPackagedSource(packaged);
}

const resolveBaseUrl = (value) => {
	let resolved;
	try {
		resolved = new URL(String(value), typeof location === 'undefined' ? undefined : location.href);
	} catch (error) {
		throw new Error(
			`baseUrl must be an absolute http(s) URL, or relative to the page in a browser: ${error.message}`,
			{ cause: error }
		);
	}
	if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') {
		throw new Error('baseUrl must use HTTP(S).');
	}
	if (!resolved.pathname.endsWith('/')) resolved.pathname += '/';
	return resolved;
};

function createHostedSource(options) {
	const baseUrl = resolveBaseUrl(options.baseUrl);
	return {
		kind: 'hosted',
		key: baseUrl.href,
		description: baseUrl.href,
		baseUrl: baseUrl.href,
		// Where the Emscripten bundle is, and where it should look for `v.wasm`.
		bundleUrl: new URL('v.js', baseUrl).href,
		locateFile: (name) => new URL(name, baseUrl).href,
		async readAsset(name) {
			const url = new URL(name, baseUrl);
			const response = await fetch(url);
			if (!response.ok) throw new Error(`Failed to load the compiler asset ${url}: ${response.status}`);
			const bytes = new Uint8Array(await response.arrayBuffer());
			// Only the assets this package reads itself can be checked; Emscripten fetches the loader
			// and `v.wasm`.
			return verifyReceipt(name, bytes);
		}
	};
}

function createPackagedSource(packaged) {
	return {
		kind: 'packaged',
		key: `packaged\u0000${packaged.root.href}`,
		description: `the assets packaged with this library (${packaged.root.href})`,
		// No URL: this package reads the bundle itself and hands Emscripten the bytes, so nothing is
		// fetched and everything can be checked.
		bundleUrl: null,
		locateFile: null,
		readAsset: async (name) => verifyReceipt(name, await packaged.readFile(name))
	};
}

export { ASSET_SOURCE };
