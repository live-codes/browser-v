// Copies the C toolchain's runtime assets out of the npm package into
// assets/clang, which is where the page and its worker fetch them from.
//
// They are ~29 MB and are not committed, so this is the step that puts them
// there:  npm run setup:clang
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);

// The IIFE bundle is the one entry point a classic worker can load, and its path
// is also the easiest way to find the package without reaching past its exports.
const iifeBundle = require.resolve('@live-codes/clang-wasm/iife/toolchain');
const packageDir = dirname(dirname(iifeBundle));
const out = join(process.cwd(), 'assets', 'clang');

mkdirSync(out, { recursive: true });

execFileSync(process.execPath, [join(packageDir, 'bin', 'copy-assets.mjs'), out], {
  stdio: 'inherit',
});
copyFileSync(iifeBundle, join(out, 'clang-wasm-toolchain.global.js'));

console.log(`C toolchain assets are in ${out}`);
