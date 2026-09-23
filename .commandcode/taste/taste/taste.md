# Taste
- Wants code to run entirely client-side in the browser with no servers — no compilation/runtime backend. Store compiler logic (WASM, in-browser compilation) entirely in the page. Confidence: 0.7
- Prefers to start new feature work with a minimal, standalone proof-of-concept (e.g., a single simple HTML page) to de-risk the approach before integrating into the main app. Confidence: 0.6
- Wants demos/playgrounds to be end-to-end functional — the user's code should actually run and the page should show the program's own output, not intermediate artifacts (e.g., the first lines of generated code). Confidence: 0.7
- Prefers the agent to keep working autonomously through long multi-step debugging/implementation sessions, prompting it on with terse nudges ("continue") rather than re-specifying or approving each step. Confidence: 0.5
- Wants binary/compiler assets built from source via a reproducible, pinned build pipeline (containerized build, pinned upstream version, hashed build receipt) instead of depending on a third-party prebuilt binary. Confidence: 0.5
- Wants the full standard library / real toolchain available to user code rather than a trimmed subset, even at the cost of much larger assets. Confidence: 0.5
- Expects problems to be attributed to their proper layer and defects in a third-party dependency fixed upstream in that library rather than worked around locally; keeps only project-specific workarounds in the project. Confidence: 0.7
- When fixing a bug, wants tests written alongside the fix ("do the fix & tests"). Confidence: 0.6
- Is mindful of the size cost of changes to a published library/package and expects that tradeoff to be measured (e.g., asking "would that increase the library size?"). Confidence: 0.5
