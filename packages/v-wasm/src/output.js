// Cleaning what a compiler said, and feeding a program its stdin.
//
// V's diagnostics arrive with SGR colour codes, and the caller wants lines, not escapes. The program's
// own output passes through untouched, because that is the program's business.

const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g;

export const stripAnsi = (text) => String(text ?? '').replace(ANSI, '');

/**
 * The compiler's diagnostics, one entry per line, colour removed.
 *
 * Empty when the compile succeeded, so `errors.length` is a reliable failure test - the same choice
 * `@live-codes/clang-wasm` makes for clang's, and for the same reason.
 */
export const compilerDiagnostics = (text) =>
	stripAnsi(text)
		.split(/\r?\n/)
		.map((line) => line.replace(/\s+$/, ''))
		.filter((line) => line.trim());

// stdin is read in chunks: hand the whole buffer over once, then signal EOF with null.
export const makeStdin = (input) => {
	if (input == null || input.length === 0) return () => null;
	let sent = false;
	return () => {
		if (sent) return null;
		sent = true;
		return input;
	};
};
