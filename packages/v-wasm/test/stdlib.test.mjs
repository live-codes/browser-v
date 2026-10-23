// Standard-library coverage: the modules a playground is expected to have.
//
// These are the ones that needed work in the C layer rather than in JavaScript: `time`, `sync` and
// `benchmark` reach C11 atomics and POSIX semaphores, and `json` is backed by V's bundled cJSON, which
// the compiler calls but does not embed. The rest are representative pure-V modules.
import assert from 'node:assert/strict';
import test from 'node:test';

import { createCompiler } from '@live-codes/v-wasm';

const CASES = [
	['time', `import time\nfn main() {\n\tprintln(time.now().unix() > 0)\n}\n`, 'true\n'],
	['sync', `import sync\nfn main() {\n\tmut m := sync.new_mutex()\n\tm.lock()\n\tm.unlock()\n\tprintln('ok')\n}\n`, 'ok\n'],
	['benchmark', `import benchmark\nfn main() {\n\tb := benchmark.new_benchmark()\n\tprintln(typeof(b).name)\n}\n`, 'benchmark.Benchmark\n'],
	['json', `import json\nfn main() {\n\tprintln(json.encode([1, 2, 3]))\n}\n`, '[1,2,3]\n'],
	['rand', `import rand\nfn main() {\n\tx := rand.intn(100) or { -1 }\n\tprintln(x >= 0 && x < 100)\n}\n`, 'true\n'],
	['math.big', `import math.big\nfn main() {\n\tprintln(big.integer_from_i64(2).str())\n}\n`, '2\n'],
	['crypto.sha256', `import crypto.sha256\nfn main() {\n\tprintln(sha256.hexhash('abc'))\n}\n`, 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad\n'],
	['crypto.md5', `import crypto.md5\nfn main() {\n\tprintln(md5.hexhash('abc'))\n}\n`, '900150983cd24fb0d6963f7d28e17f72\n'],
	['encoding.base64', `import encoding.base64\nfn main() {\n\tprintln(base64.encode('abc'.bytes()))\n}\n`, 'YWJj\n'],
	['encoding.hex', `import encoding.hex\nfn main() {\n\tprintln(hex.encode('abc'.bytes()))\n}\n`, '616263\n'],
	['hash.crc32', `import hash.crc32\nfn main() {\n\tprintln(crc32.sum('abc'.bytes()))\n}\n`, '891568578\n'],
	['datatypes', `import datatypes\nfn main() {\n\t_ := datatypes.Stack[int]{}\n\tprintln('ok')\n}\n`, 'ok\n'],
];

const compiler = await createCompiler();

for (const [name, code, expected] of CASES) {
	test(`stdlib: ${name}`, async () => {
		const result = await compiler.run(code);
		assert.deepEqual(result.errors, [], `${name}: ${result.errors.join('\n')}`);
		assert.equal(result.stdout, expected);
	});
}
