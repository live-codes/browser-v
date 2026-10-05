// One implementation, two entry points: `index.js` for anywhere without a filesystem, and
// `index.node.js` for Node, which can also read the assets that ship in this package. The one thing
// that differs between those environments - how the compiler is loaded - is handed in rather than
// guessed at.
import { resolveAssetSource } from './assets.js';
import { compileVSource, loadClangToolchain, runArtifact } from './clang.js';
import { compilerDiagnostics, stripAnsi } from './output.js';

export function createApi({ packaged, loadVCompiler }) {
	/**
	 * Create a compiler. One instance compiles any number of programs, because the V compiler is
	 * loaded once and kept warm - it holds the whole standard library in its memory filesystem.
	 *
	 * @param {object} [options]
	 * @param {string} [options.baseUrl] - where the compiler's assets are served from. Required
	 *   anywhere without a filesystem; in Node it can be omitted to use the assets in this package.
	 * @param {string} [options.clangBaseUrl] - where the Clang toolchain's assets are. Passed to
	 *   `@live-codes/clang-wasm`, whose rules apply: required in a browser, optional in Node. The
	 *   runtime is shared with any C/C++ compilers created against the same assets.
	 * @param {string[]} [options.compileArgs] - extra V flags, before the source path.
	 * @param {string[]} [options.clangArgs] - extra clang flags.
	 * @param {string[]} [options.args] - default program argv.
	 * @param {(value: number) => void} [options.onProgress] - toolchain download progress, 0 to 1.
	 * @param {(text: string, stream: string) => void} [options.onLog] - the compilers' own output.
	 * @param {(text: string, stream: 'out'|'err') => void} [options.onOutput] - the program's output as
	 *   it is written, for a caller that wants to show a slow program while it runs. The result carries
	 *   the whole of it either way, and is what a caller should draw from when the run ends.
	 * @param {(text: string) => void} [options.onStatus] - what is happening, for a status line.
	 */
	async function createCompiler(options = {}) {
		const source = resolveAssetSource(options, packaged);
		const onLog = options.onLog ?? (() => {});
		const onStatus = options.onStatus ?? (() => {});

		const compiler = await loadVCompiler({ source, onStatus });

		// The compiler's output since the last compile, forwarded to the caller's log and turned into
		// diagnostics. Drained rather than pushed, because the loaded compiler is shared between
		// compilers made against the same assets.
		const takeOutput = () => {
			const raw = compiler.takeOutput();
			if (raw.trim()) onLog(raw, 'v');
			return compilerDiagnostics(raw);
		};

		let toolchainPromise = null;
		const toolchain = () => {
			if (!toolchainPromise) {
				toolchainPromise = loadClangToolchain({
					baseUrl: options.clangBaseUrl,
					onProgress: options.onProgress
				});
			}
			return toolchainPromise;
		};

		// The V compiler and the Clang runtime each own one filesystem and one process, so two runs at
		// once would write over each other's files. Runs queue rather than interleave.
		let tail = Promise.resolve();
		const serialize = (work) => {
			const run = tail.then(work, work);
			tail = run.then(
				() => {},
				() => {}
			);
			return run;
		};

		// A compile that produced nothing has no diagnostics of its own, so it needs a sentence of ours.
		const failure = (compileMs, errors, fallback = 'The V compiler produced no output.') => ({
			ok: false,
			stdout: '',
			stderr: '',
			output: '',
			errors: errors.length ? errors : [fallback],
			exitCode: null,
			compileMs,
			runMs: null
		});

		return {
			/** Where the compiler's assets came from, for an error message a user can act on. */
			assetSource: source.description,

			/**
			 * Compile and run a program.
			 *
			 * @param {string} code - the program source.
			 * @param {string|Uint8Array} [input] - stdin, handed to the program once and then closed.
			 * @param {object} [runOptions] - per-run overrides: `args`, `compileArgs`, `clangArgs`, and
			 *   `onOutput`.
			 * @returns {Promise<{stdout: string, stderr: string, output: string, errors: string[],
			 *   exitCode: number|null, compileMs: number, runMs: number|null}>} `output` is stdout and
			 *   stderr in the order the program wrote them. `errors` holds the compilers' diagnostics and
			 *   is empty when it compiled; `exitCode` is null when the program never ran.
			 */
			async run(code, input = '', runOptions = {}) {
				if (typeof code !== 'string') {
					throw new Error('run() needs the program source as its first argument.');
				}

				return serialize(async () => {
					const compileStarted = performance.now();
					const compileArgs = runOptions.compileArgs ?? options.compileArgs ?? [];

					// Drain anything the previous compile left, so this one's diagnostics are its own:
					// the loaded compiler is shared between compilers made against the same assets.
					takeOutput();

					const compiled = compiler.compileToC(code, compileArgs);
					const diagnostics = takeOutput();
					if (!compiled.ok) {
						return failure(Math.round(performance.now() - compileStarted), diagnostics);
					}

					// The toolchain is ~29 MB and loads on first use, so say so before the wait rather
					// than leaving a status line blank until it is done.
					if (!toolchainPromise) onStatus('loading the C→wasm toolchain…');
					const built = await toolchain();
					onStatus('compiling to wasm…');

					let artifact;
					try {
						artifact = await compileVSource(built, {
							cSource: compiled.cSource,
							readInclude: compiler.readFile,
							compileArgs: runOptions.clangArgs ?? options.clangArgs ?? [],
							onCompilerOutput: (raw) => onLog(stripAnsi(raw), 'clang')
						});
					} catch (error) {
						return {
							ok: false,
							stdout: '',
							stderr: '',
							output: '',
							// The failure carries clang's or the linker's own words, already stripped of the
							// runtime's chatter.
							errors: [stripAnsi(error?.message ?? error)],
							exitCode: null,
							// `compileMs` is the whole build: V's codegen plus clang and the link, which is
							// what a caller waiting for a result is actually waiting for.
							compileMs: Math.round(performance.now() - compileStarted),
							runMs: null
						};
					}

					const compileMs = Math.round(performance.now() - compileStarted);

					onStatus('running…');
					const stdout = [];
					const stderr = [];
					const order = [];
					const onOutput = runOptions.onOutput ?? options.onOutput ?? (() => {});
					const runStarted = performance.now();
					const ran = await runArtifact(built, artifact, {
						args: runOptions.args ?? options.args ?? [],
						stdin: input,
						onStdout: (chunk) => {
							stdout.push(chunk);
							order.push(chunk);
							onOutput(chunk, 'out');
						},
						onStderr: (chunk) => {
							stderr.push(chunk);
							order.push(chunk);
							onOutput(chunk, 'err');
						}
					});

					return {
						ok: ran.exitCode === 0,
						stdout: stdout.join(''),
						stderr: stderr.join(''),
						output: order.join(''),
						errors: [],
						exitCode: ran.exitCode,
						compileMs,
						runMs: Math.round(performance.now() - runStarted)
					};
				});
			}
		};
	}

	return { createCompiler };
}
