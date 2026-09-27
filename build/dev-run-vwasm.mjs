// Dev harness: run a module the *V compiler itself* emitted (-b wasm -os wasi), through the
// same WASI shim the page uses. This is the other half of the C route's dev-run.mjs: no clang,
// no C, no sysroot.
//
//   node dev-run-vwasm.mjs <module.wasm> [stdin]
import { readFileSync } from 'node:fs';
import { createToolchain } from '@live-codes/clang-wasm/toolchain';

const file = process.argv[2];
const stdin = process.argv[3] ?? '';
const bytes = Uint8Array.from(readFileSync(file));

const module = await WebAssembly.compile(bytes);
const imports = WebAssembly.Module.imports(module);
console.log(`# module: ${file} (${bytes.length} bytes, ${imports.length} imports)`);

const toolchain = await createToolchain();
const chunks = [];
let result;
try {
	result = await toolchain.execute(
		{ bytes, wasm: module, target: 'wasm32-wasi', format: 'wasi-core-wasm' },
		{
			args: [],
			stdin,
			stdout: (chunk) => chunks.push(chunk),
			stderr: (chunk) => chunks.push(chunk)
		}
	);
} catch (error) {
	console.log(`# run threw: ${error.message}`);
	toolchain.dispose();
	process.exit(1);
}

console.log(`# exitCode: ${result.exitCode}`);
console.log('# program output:');
console.log(chunks.join(''));
toolchain.dispose();
