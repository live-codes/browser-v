// The `c` target: stop at the generated C and hand it back.
//
// Mirrors `@live-codes/nim-wasm`'s source targets — `compiledCode` is the artifact — and the Clang
// toolchain is never loaded because nothing needs compiling. V emits one translation unit, so there is
// one shape: the C itself.
import assert from 'node:assert/strict';
import test from 'node:test';

import { createCompiler, TARGETS, targets } from '@live-codes/v-wasm';

const PROGRAM = `fn main() {\n\tprintln('hi')\n}\n`;

// A marker that is always in V's generated C, whatever else changes.
const C_MARKER = 'int main(';

test('the targets are the ones documented', () => {
	assert.deepEqual(targets, ['wasm', 'c']);
	assert.equal(TARGETS.WASM, 'wasm');
	assert.equal(TARGETS.C, 'c');
});

test('an unknown target is rejected with the list of valid ones', async () => {
	await assert.rejects(
		() => createCompiler({ target: 'js' }),
		/Unknown target[\s\S]*wasm, c/
	);
});

test('c: hands back the generated C as one string, and runs nothing', async () => {
	const compiler = await createCompiler({ target: 'c' });
	const result = await compiler.run(PROGRAM);

	assert.equal(compiler.target, 'c');
	assert.deepEqual(result.errors, []);
	assert.equal(result.exitCode, null);
	assert.equal(result.runMs, null);
	assert.equal(result.output, '');
	assert.equal(typeof result.compiledCode, 'string');
	assert.match(result.compiledCode, /V comptime_definitions/);
	assert.ok(result.compiledCode.includes(C_MARKER));
	assert.ok(result.compileMs > 0);
});

test('c: diagnostics still come back, and nothing is handed over when it fails', async () => {
	const compiler = await createCompiler({ target: 'c' });
	const result = await compiler.run(`fn main() {\n\tundefined_symbol()\n}\n`);

	assert.equal(result.compiledCode, undefined);
	assert.equal(result.exitCode, null);
	assert.ok(result.errors.length > 0);
});

test('c: the Clang toolchain is never loaded', async () => {
	// A base URL nothing can answer on. A `wasm` run would fail here; the source target must not reach it.
	const compiler = await createCompiler({ target: 'c', clangBaseUrl: 'http://127.0.0.1:1/' });
	const result = await compiler.run(PROGRAM);

	assert.deepEqual(result.errors, []);
	assert.equal(typeof result.compiledCode, 'string', 'expected compiledCode without loading clang');
});
