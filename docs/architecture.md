# Architecture

## Goal

JevTrace is being built toward a **JS/TS-focused superset of [jevgrep](https://github.com/dzhng/jevgrep)**: repository discovery plus deeper compiler-aware context retrieval in one tool. It accepts a coding task alone or a known source location. Jev can be reached through OpenRouter, TypeSafe directly, Vercel AI Gateway, OpenCode Zen, or a custom System One-compatible endpoint (see [usage](usage.md#jev-provider-and-model)).

The core bet is that JS/TS gives us something a generic repository retriever does not have: the compiler already knows a large part of the program structure. JevTrace uses that information to resolve aliases, imports, calls, methods, types, callers, and test references before asking Jev to judge relevance. That lets the decision model work on a smaller and more precise candidate set, while frontier batching keeps the number of provider round trips low. The product goal is therefore not just "search, then filter"; it is **compiler-guided discovery and retrieval with higher structural precision and lower decision latency for JS/TS codebases**.

The on-demand partial graph is inspired by [DyRetriever](https://arxiv.org/html/2608.01927v1). DyRetriever uses an LLM to select entry functions and infer downstream relationships. JevTrace instead resolves relationships from compiler state wherever possible and uses Jev primarily for task relevance rather than for reconstructing the graph itself.

The intended superset is **JS/TS-specialized**, not a claim that a compiler-backed tool should replace generic retrieval for every language. JevTrace aims to combine:

- repository discovery from a natural-language coding task;
- TypeScript-aware symbol and project resolution;
- typed forward dependencies plus caller/test references;
- bounded supporting context derived from compiler-resolved local constants and types;
- Jev relevance filtering over compiler-produced candidates;
- frontier batching and caching to minimize remote decision round trips;
- structured paths, omissions, unresolved references, and budget/depth warnings for coding agents.

Discovery is an initial implementation, not yet evidence of parity with jevgrep.

## Task-only pipeline

The default path is **lexical-assisted Jev discovery → compiler shallow expansion → conditional Stage 4 ranking**, chosen from the development ablations in [discovery-evaluation.md](discovery-evaluation.md).

0. **Task scope check.** Alongside discovery, one Jev question asks whether the task names one behaviour or area a search can locate. Below 0.5 ("find critical bugs", "review the whole project", "scaffold the project"), discovery is stopped and the result has status `broad`: suggested subtasks (the task restricted to each of up to 16 areas, `<task> — only in <dir>/ (<names>)`, found by splitting the largest directory first) plus a repository map (source-file count and top-level declarations per directory, merged into parent directories until it fits), so the agent can call again once per area. The restricted wording scored 0.85–0.95 for every broad task tried. On 27 specific tasks, including the 19 benchmark tasks and Korean phrasings, the score was 0.62–0.93; on 14 broad ones it was 0.09–0.48, except "Add rate limiting" (0.64), which is retrieved normally. The question runs in parallel, so specific tasks pay no extra latency; a failed check is noted and retrieval continues. `scopeCheck: false` skips it, and offline mode has no judge to ask.
1. **Lexical-assisted repository discovery.** JevTrace scans supported JS/TS files for declarations and caches compiler-derived fields. Unchanged files (same mtime and size) are neither re-read nor re-parsed, and one scan is shared by lexical ranking and structure discovery.
   - **What is indexed.** The index lists only declarations the compiler adapter can resolve again: callables, class members, and *top-level* function-valued variables. A variable nested inside a callback, such as a test's `describe` body, is not a lead.
   - **Type-level declarations.** Interfaces, type aliases, enums, and classes without indexed members are semantic leads for Jev. They are excluded from lexical ranking, so large option interfaces cannot dominate it, and they only fill lead slots that qualifying callables leave open.
   - **Multiple projects.** Repositories with several projects are indexed across the union of `tsconfig*.json` and `jsconfig*.json` files. A config owns its directory; sources under no config are indexed too and analysed with `allowJs`.
   - **Vue components.** `.vue` files are parsed with Vue's own SFC parser (`@vue/compiler-sfc`, loaded only when a repository has them). The script blocks stay in place and the template, styles and tags are blanked to spaces with newlines kept, so the TypeScript compiler reads the component as a script with the file's own positions and line numbers; no source map is involved. `.vue` imports resolve through the same `paths` aliases as scripts, and top-level `<script setup>` calls are attributed to the component. Template expressions are not analysed.
   - **Size.** Up to 20,000 source files are indexed (tokens are interned, about 16 KB per file); the limit counts only files a project includes.
   - **Lexical ranking.** Local retrieval computes BM25F over symbol name, path, signature, referenced identifiers, and literals. It fuses that with exact and path matching through reciprocal-rank fusion.
   - **Jev structure discovery.** Jev scores directory scopes, then files inside the selected scopes, then symbols inside the selected files.
   - **Directory scopes are adaptive.** A directory remains one scope while its subtree holds at most 64 files; otherwise it is split into its child directories. A small repository is therefore a single scope and skips the directory decision entirely.
   - **File cap.** `maxJevFiles` applies after directory selection. Inside each selected scope, files are ordered by their best lexical score, so the cap drops lexically weak files rather than alphabetically late ones.
   - **Lexical hints and rescue.** Lexical top results are supplied as hints and never constrain Jev's candidate space. **Lexical rescue** also sends the files of the four strongest lexical matches to file-level judging, even when their scope lost the directory decision or the file cap (`lexicalRescueFiles`, reported as `rescuedFiles`, disabled in the pure-Jev ablation). Jev still has to select a rescued file.
2. **Diverse semantic leads.** JevTrace keeps up to four qualifying Jev symbol leads rather than forcing one canonical entry. A best-effort diversity rule compares one-hop compiler neighborhoods and suppresses candidates whose local graph substantially overlaps an already selected lead.
3. **Compiler shallow expansion.** Each lead is resolved with the TypeScript `Program`, `TypeChecker`, and `LanguageService`.
   - **Edges.** JevTrace collects one-hop calls, methods, constructors, JSX, imports/types, callers, and tests. It follows import aliases across files, caps reverse fan-in, and merges duplicate nodes across leads. For a type-level lead, reverse expansion also records the callables that use the type through annotations or member access.
   - **Resolution failures.** A lead the compiler cannot resolve is skipped with a warning instead of failing the retrieval.
   - **Caching.** Forward and reverse scans are memoized per TypeScript `Program`; an edited file produces a new program and therefore fresh scans. The diversity check and expansion do not repeat `findReferences`, and the language services of the four most recently used tsconfig projects stay warm.
   - **Caps.** Per-lead and neighborhood caps charge a candidate's signature cost when its body does not fit, so a large relevant neighbor survives long enough to be returned as a signature.

   Repeated ablations show this stage does substantive recovery rather than cosmetic expansion.
4. **Conditional final ranking.** The compiler neighborhood is the primary final-context candidate set.
   - **When Stage 4 runs.** If the neighborhood fits `tokenBudget`, no further Jev call is made. If it exceeds the budget, Stage 4 rescores candidates on a common final-context usefulness scale before the budget cut.
   - **Provisional choices.** Merging lexical RRF candidates into the final pool is still supported, and Jev/structural scores are blended 70/30. Both are provisional: development ablations favored lexical hints over unconditional final merging, and the Stage 4 sweep showed the current weight can sometimes override strong structural evidence.
   - **Budget cut.** In ranking order, each candidate gets its body when it fits, otherwise its signature, otherwise it is omitted. Remaining budget then upgrades signatures back to bodies in ranking order.
   - **Degradation instead of failure.** A malformed provider answer leaves only that candidate undecided (scored 0 in discovery, structural score in Stage 4) with a warning. A failed discovery provider stage falls back to the lexical leads, and a failed Stage 4 falls back to the structural order. Cancellation still aborts.
5. **Explicit-entry compatibility path.** Supplying a file/line uses the older iterative dependency retriever instead. It has depth/node thresholds, body/signature/omitted decisions, wrapper lookahead, and optional Choice traversal. This path is useful when an agent already has a trusted entry location.
6. **Structured result.** Task-only results expose the intermediate result of every stage, so evaluation can attribute a failure to one stage instead of only reporting end-to-end recall:
   - `lexicalCandidates`;
   - Jev `directoryLeads` and `fileLeads`;
   - diversity-selected `semanticLeads`;
   - the capped compiler `neighborhood` and the final `rankingPool`;
   - whether conditional context ranking ran;
   - final context and omissions;
   - provider traces, unresolved references, and pruning warnings.

## Judges and providers

`LanguageAdapter` and `RelevanceJudge` are separate interfaces. Relevance judging (`DecisionJudge` in `src/judges.ts`) builds the questions, batches them, caches answers and limits concurrency; it never touches a provider's wire format. That lives behind `DecisionBackend` (`src/decision-backends.ts`): a provider-neutral request of a shared `state` plus probability or choice `questions`, answered with a probability or option per question and optional usage (input tokens, cost). Jev's System One format, which TypeSafe, OpenRouter, Vercel AI Gateway and OpenCode Zen all serve, is one backend.

### Adding a decision provider

1. Implement `DecisionBackend` for the provider's API: `serialize(request)` returns the exact request body (it is also the answer-cache key), and `decide(request)` sends it, usually through the shared `postJson` helper (one retry of a transient failure, timeouts, readable provider errors), and maps the response to per-question answers and usage.
2. Register it in `providers` in `src/decision-backends.ts` with its key variable, endpoint and default model. It is then selectable with `JEVTRACE_PROVIDER` / `--provider`.

Nothing in discovery, compiler expansion or ranking changes. `test/robustness.test.mjs` plugs in a backend with a different request and response shape and runs the whole pipeline through it.

- **Caching and limits.** The MCP process holds a bounded in-memory digest cache of successful Jev answers. It limits concurrent provider requests to four and retries one transient provider or network failure.
- **Cancellation and errors.** MCP cancellation is propagated to provider calls. Non-2xx responses preserve useful provider details instead of only the status code.
- **Offline mode.** `--offline` or the `include-all` judge bypasses remote judging.

The task, entry source, candidate source, call-site metadata, and bounded supporting snippets are sent to the selected provider.

### Relevance payload

A candidate such as `normalizeRetryOptions` can look generic when Jev sees only its own body, even though same-file constants such as retry status-code defaults explain its role. Jev requests therefore include:

```text
task
entry: signature + bounded body
relationship: edge kind + depth + call site
candidate: signature + bounded body
supporting context: checker-resolved same-file constants/types, max two local hops
```

Supporting context is deliberately bounded rather than expanding another full graph.

## Limitations

- **Broad tasks.** The scope check (stage 0) keeps project-wide requests from getting an arbitrary slice of code, but they get a map, not an answer: JevTrace does not review, audit or scaffold. A borderline task can land on either side of the threshold; the agent can rephrase it or pass `scopeCheck: false`. `complete` still describes the traversal, not whether the task is fully covered.
- **Supported projects.** See [Supported projects](usage.md#supported-projects). Callers of a CommonJS function re-exported under a computed name or through several modules may be missed.
- Static analysis is incomplete for dynamic imports, dependency injection, callback invocation, and `any`-driven dispatch.
- A `complete` status means the configured traversal finished without recorded gaps. It is not a proof that all runtime dependencies were found.
- `findReferences` can be expensive in a large project and may miss references outside the selected TypeScript project.
- The MCP server serializes retrievals because the compiler adapter keeps one active project at a time.
