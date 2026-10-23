// The entry every environment gets unless something more specific matches, so it has to work without a
// filesystem: `baseUrl` is required because a browser cannot read a file that lives inside an npm
// package.
import { createApi } from './api.js';
import { TARGETS } from './targets.js';
import { loadVCompiler } from './v.js';

const api = createApi({ packaged: null, loadVCompiler });

export const createCompiler = api.createCompiler;
export { TARGETS };
export const targets = Object.values(TARGETS);
