// Inflating a gzipped asset.
//
// The compiler and its standard library ship gzipped, so the size a host has to transfer does not
// depend on whether that host compresses anything itself. `DecompressionStream` is the one API for
// this that exists in both a browser and Node (18 and later), so there is a single implementation
// rather than a `node:zlib` branch.
export async function inflateGzip(bytes) {
	if (typeof DecompressionStream !== 'function') {
		throw new Error(
			'Reading the compressed compiler assets needs DecompressionStream: a browser that has it, ' +
				'or Node 18 and later.'
		);
	}
	const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
	return new Uint8Array(await new Response(stream).arrayBuffer());
}
