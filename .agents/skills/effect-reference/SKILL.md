---
name: effect-reference
description: Look up Effect 4 APIs from the installed source and effect-solutions before guessing.
---

# Effect reference

Effect 4 drifts from training data. Before writing Effect code:

1. Read the matching file under `node_modules/effect/src`.
2. Run `bunx effect-solutions@latest show <topic>` when the question is a pattern (layers, errors, schema).
3. Import public modules: `effect`, `effect/http`, `effect/http-api`. This package does not ship `effect/unstable/http`.
