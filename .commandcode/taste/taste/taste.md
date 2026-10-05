# Taste
- Wants code to run entirely client-side in the browser with no servers — no compilation/runtime backend. Store compiler logic (WASM, in-browser compilation) entirely in the page. Confidence: 0.7
- Prefers to validate new feature work as a standalone unit before integrating it into the consuming app: start with a minimal proof-of-concept (e.g., a single simple HTML page), grow it into a self-contained package, and only wire it into the main app once that piece is publishable — integration is explicitly deferred until then. Confidence: 0.7
- Wants demos/playgrounds to be end-to-end functional — the user's code should actually run and the page should show the program's own output, not intermediate artifacts (e.g., the first lines of generated code). Confidence: 0.7
- Prefers the agent to keep working autonomously through long multi-step implementation/debugging sessions, giving a terse go-ahead directive ("start now", "continue") and no step-by-step approval rather than re-specifying each step. Confidence: 0.6
- Wants binary/compiler assets built from source via a reproducible, pinned build pipeline (containerized build, pinned upstream version, hashed build receipt) instead of depending on a third-party prebuilt binary. Confidence: 0.5
- Wants the full standard library / real toolchain available to user code rather than a trimmed subset, even at the cost of much larger assets. Confidence: 0.5
- Expects problems to be attributed to their proper layer and defects in a third-party dependency fixed upstream in that library rather than worked around locally; keeps only project-specific workarounds in the project. Confidence: 0.7
- When fixing a bug, wants tests written alongside the fix ("do the fix & tests"). Confidence: 0.6
- Is mindful of the size cost of changes to a published library/package and expects that tradeoff to be measured (e.g., asking "would that increase the library size?"). Confidence: 0.5
