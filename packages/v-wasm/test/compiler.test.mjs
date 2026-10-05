// The pipeline end to end, off the assets that ship in this package.
//
// Run from the package directory: `npm test`. The V compiler is the bundled `v.wasm` compiled from a
// pinned commit, and the C it emits is compiled and linked by `@live-codes/clang-wasm`'s toolchain,
// which needs no baseUrl in Node either.
import assert from 'node:assert/strict';
import test from 'node:test';

import { createCompiler } from '@live-codes/v-wasm';

const HELLO_AND_MORE = `import math

struct Point {
mut:
	x int
	y int
}

fn (p Point) norm2() int {
	return p.x * p.x + p.y * p.y
}

fn fib(n int) int {
	if n < 2 {
		return n
	}
	return fib(n - 1) + fib(n - 2)
}

fn main() {
	println('Hello, browser!')
	names := ['v', 'wasm']
	println('names = \${names}')
	for i in 0 .. 3 {
		println('fib(\${i}) = \${fib(i)}')
	}
	println('pi = \${math.pi}')
	p := Point{x: 3, y: 4}
	println('norm2 = \${p.norm2()}')
}
`;

const EXPECTED = [
	'Hello, browser!',
	"names = ['v', 'wasm']",
	'fib(0) = 0',
	'fib(1) = 1',
	'fib(2) = 1',
	'pi = 3.141592653589793',
	'norm2 = 25'
].join('\n');

test('compiles, links and runs, with the result shape', async () => {
	const compiler = await createCompiler();
	const result = await compiler.run(HELLO_AND_MORE);

	assert.deepEqual(result.errors, []);
	assert.equal(result.stdout, `${EXPECTED}\n`);
	assert.equal(result.stderr, '');
	assert.equal(result.output, `${EXPECTED}\n`);
	assert.equal(result.exitCode, 0);
	assert.ok(result.compileMs > 0);
	assert.ok(result.runMs >= 0);
	assert.match(compiler.assetSource, /assets packaged with this library/);
});

test('a V error is reported as diagnostics, with source context, and nothing runs', async () => {
	const compiler = await createCompiler();
	const result = await compiler.run(`fn main() {\n\tx := 'a' + 1\n\tprintln(x)\n}\n`);

	assert.equal(result.exitCode, null);
	assert.equal(result.runMs, null);
	assert.ok(
		result.errors.some((line) => /error:/i.test(line)),
		`expected diagnostics, got:\n${result.errors.join('\n')}`
	);
	// Diagnostics come back without colour, since the compiler writes them with it.
	assert.ok(!/\u001b\[/.test(result.errors.join('\n')), 'expected ANSI escapes to be stripped');
});

test('a compile produces no artifact when the program does not build', async () => {
	const compiler = await createCompiler();
	const result = await compiler.run('fn main() {\n\tundefined_symbol()\n}\n');

	assert.ok(result.errors.length > 0);
	assert.equal(result.exitCode, null);
});

test('program output arrives while it is written, not only at the end', async () => {
	const compiler = await createCompiler();
	const streamed = [];
	const result = await compiler.run(
		`fn main() {\n\tfor i in 0 .. 3 {\n\t\tprintln(i)\n\t}\n}\n`,
		'',
		{ onOutput: (text) => streamed.push(text) }
	);

	assert.deepEqual(result.errors, []);
	assert.equal(streamed.join(''), result.stdout);
	assert.match(result.stdout, /0\n1\n2\n/);
});

test('args reach the program', async () => {
	const compiler = await createCompiler({ args: ['one'] });
	const program = `import os

fn main() {
	args := os.args
	println('\${args.len}:\${args[1..].join(',')}')
}
`;
	assert.equal((await compiler.run(program)).stdout, '2:one\n');
	assert.equal((await compiler.run(program, '', { args: ['a', 'b'] })).stdout, '3:a,b\n');
});

test('stdin reaches the program', async () => {
	const compiler = await createCompiler();
	const result = await compiler.run(
		`import os\n\nfn main() {\n\tline := os.input('')\n\tprintln('got: ' + line)\n}\n`,
		'hello stdin\n'
	);
	assert.deepEqual(result.errors, []);
	assert.equal(result.stdout, 'got: hello stdin\n');
});

test('compileArgs reach the compiler', async () => {
	const compiler = await createCompiler({ compileArgs: ['-d', 'vwasm_test'] });
	const result = await compiler.run(
		`fn main() {\n\t$if vwasm_test {\n\t\tprintln('defined')\n\t} $else {\n\t\tprintln('not defined')\n\t}\n}\n`
	);
	assert.deepEqual(result.errors, []);
	assert.equal(result.stdout, 'defined\n');
});

test('one compiler keeps working across runs', async () => {
	const compiler = await createCompiler();
	assert.equal((await compiler.run(`fn main() {\n\tprintln('first')\n}\n`)).stdout, 'first\n');
	assert.equal((await compiler.run(`fn main() {\n\tprintln('second')\n}\n`)).stdout, 'second\n');
	assert.equal((await compiler.run(`fn main() {\n\tprintln('third')\n}\n`)).stdout, 'third\n');
});

test('runs on one compiler queue instead of interleaving', async () => {
	const compiler = await createCompiler();
	const [a, b] = await Promise.all([
		compiler.run(`fn main() {\n\tprintln('aaa')\n}\n`),
		compiler.run(`fn main() {\n\tprintln('bbb')\n}\n`)
	]);
	assert.equal(a.stdout, 'aaa\n');
	assert.equal(b.stdout, 'bbb\n');
});

test('without a filesystem baseUrl is required, and the error says what to do', async () => {
	const browserEntry = await import('../src/index.js');
	await assert.rejects(
		() => browserEntry.createCompiler(),
		/baseUrl is required here[\s\S]*copy-assets/
	);
});
