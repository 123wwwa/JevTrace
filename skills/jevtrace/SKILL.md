---
name: jevtrace
description: Use compiler-guided JS/TS repository retrieval to find or expand task-relevant code context before editing.
---

# JevTrace

Use this skill for JavaScript/TypeScript coding tasks where the agent needs repository context before editing. JevTrace is being built as a JS/TS-focused superset of jevgrep: repository discovery plus compiler-aware dependency retrieval in one tool.

## Current workflow

If you already have a strong file/line lead, call `retrieve_dependency_context` directly. If discovery is needed, call JevTrace with the task alone (or use `discover_entries`). Task-only retrieval uses local BM25F/exact/path retrieval as cheap guidance for a Jev path that reads the repository tree, selects relevant directory scopes, scores files inside those scopes, then chooses semantic leads from the selected files. The Jev path is not bounded by the lexical top-k. Jev leads receive bounded one-hop compiler expansion, and that compiler neighborhood is the default final candidate pool. Jev is called again only if the compiler pool exceeds the final context budget. Merging lexical candidates into the final pool is now an explicit compatibility/ablation option rather than the default.

Prefer JevTrace over plain text expansion after a JS/TS lead because it uses the TypeScript `Program`, `TypeChecker`, and `LanguageService` to resolve structural relationships before asking Jev for relevance. It can follow imports, aliases, calls, methods, constructors, JSX, types, callers, and test references, and can attach bounded compiler-resolved supporting constants/types to relevance decisions.

1. If an entry is already known, pass its file and line. Otherwise send the task alone and inspect `lexicalCandidates`, Jev `directoryLeads` / `fileLeads`, `semanticLeads`, compiler `neighborhood`, and the final `rankingPool` when retrieval quality matters.
2. Treat lexical RRF primarily as discovery guidance. A miss in `lexicalCandidates` does not imply the Jev path cannot find a useful lead, and lexical candidates are not added to the final pool by default.
3. Read the compiler neighborhood and pruning warnings. Reverse fan-in, per-lead bounds, and the total neighborhood budget may intentionally cap compiler coverage.
4. When `contextRankingApplied` is true, Jev scores affect ordering only; the final cut is budget-based and also uses structural priors. A false Jev include decision is not itself a hard exclusion. If the pool already fits, no second Jev call is made.
5. Confirm source and tests before editing. Static analysis can still miss runtime dispatch, dynamic imports, dependency injection, callbacks, or `any`-driven calls.

JevTrace batches independent semantic-discovery and context-ranking questions through the Jev transport. Each semantic lead receives one-hop forward/reverse compiler expansion; reverse fan-in is capped (12 by default), and merged neighborhoods are bounded before any conditional second Jev call. The JS/TS specialization is intentional: Jev judges task meaning while the compiler supplies program structure.

## Provider selection

OpenRouter is the default provider. Jev can also be reached through TypeSafe, Vercel AI Gateway, OpenCode Zen, or a custom compatible endpoint. Provider selection changes transport, not the retrieval algorithm.

If the MCP server is unavailable, run:

```bash
jevtrace query --task "..." --file src/file.ts --line 42 --root /project
jevtrace query --task "..." --evidence evidence.json --root /project
jevtrace query --task "..." --file src/file.ts --line 42 --root /project --provider typesafe --model jev-1.13
```

Use `--offline` only when an unfiltered compiler-resolved baseline is desired.
