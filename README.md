# JevTrace

**Compiler-native, Jev-powered context retrieval for JavaScript/TypeScript coding agents.**

JevTrace is being built toward a **JS/TS-focused superset of [jevgrep](https://github.com/dzhng/jevgrep)**: repository discovery plus deeper compiler-aware context retrieval in one tool. The current MVP accepts a coding task alone or a known source location. Task-only discovery combines a local lexical retriever (BM25F + exact/path matching through RRF) with Jev repository-structure discovery over directories, files, and symbols. Lexical results can guide Jev without bounding its search space. Jev-selected semantic leads are then expanded one hop with the TypeScript compiler. The current implementation still supports merging lexical candidates into the final pool, but repeated development ablations now point to a leaner default direction: **lexical-assisted Jev discovery → compiler expansion → conditional Stage 4 ranking only when the compiler neighborhood exceeds the final budget**. Discovery is an initial implementation, not yet evidence of parity with jevgrep. Jev can be reached through OpenRouter, TypeSafe directly, Vercel AI Gateway, OpenCode Zen, or a custom System One-compatible endpoint.

The core bet is that JS/TS gives us something a generic repository retriever does not have: the compiler already knows a large part of the program structure. JevTrace uses that information to resolve aliases, imports, calls, methods, types, callers, and test references before asking Jev to judge relevance. That should let the decision model operate on a smaller and more precise candidate set, while frontier batching keeps the number of provider round trips low. The product goal is therefore not just "search, then filter"; it is **compiler-guided discovery and retrieval with higher structural precision and lower decision latency for JS/TS codebases**.

The on-demand partial graph is inspired by [DyRetriever](https://arxiv.org/html/2608.01927v1). DyRetriever uses an LLM to select entry functions and infer downstream relationships. JevTrace instead resolves relationships from compiler state wherever possible and uses Jev primarily for task relevance rather than for reconstructing the graph itself. Compiler resolution is still incomplete for dynamic imports, dependency injection, callback invocation, and `any`-driven dispatch.

## Run

Requires Node.js 20 or newer.

```bash
npm install
npm run build
npm test
```

Local CLI query:

```bash
jevtrace query --root /absolute/project --task "Fix refresh token validation"
jevtrace discover --root /absolute/project --task "Fix refresh token validation"
jevtrace query --root /absolute/project --task "Fix refresh token validation" --file src/auth.ts --line 42
jevtrace query --root /absolute/project --task "Fix refresh token validation" --evidence evidence.json
jevtrace query --root /absolute/project --task "Fix refresh token validation" --evidence evidence.json --visit-policy choice
jevtrace query --root /absolute/project --task "Fix refresh token validation" --file src/auth.ts --line 42 --provider typesafe --model jev-1.13
```

From this checkout, replace `jevtrace` with `node dist/cli.js`. The CLI emits structured JSON. For task-only queries, `--offline` uses the lexical branch as leads, compiler shallow expansion, and structural budget cutting without Jev. Explicit file/line queries keep the older include-all compiler baseline. The package is not published to npm yet; after publication, MCP hosts can run `npx -y jevtrace --root /absolute/project`.

### Jev provider and model

JevTrace defaults to OpenRouter, but provider and model selection are independent configuration. CLI queries accept `--provider` and `--model`; MCP hosts configure the same values through environment variables.

| Provider | `JEVTRACE_PROVIDER` | Credential | Default model | Endpoint |
| --- | --- | --- | --- | --- |
| OpenRouter | `openrouter` | `OPENROUTER_API_KEY` | `typesafe/jev-1.13` | `https://openrouter.ai/api/alpha/decisions` |
| TypeSafe | `typesafe` | `TYPESAFE_API_KEY` | `jev-latest` | `https://api.typesafe.ai/v1/systemone` |
| Vercel AI Gateway | `vercel` | `AI_GATEWAY_API_KEY` | `typesafe-ai/jev` | `https://ai-gateway.vercel.sh/typesafe/v1/systemone` |
| OpenCode Zen | `opencode` | `OPENCODE_API_KEY` | `jev-1.13` | `https://opencode.ai/zen/v1/systemone` |
| Custom | `custom` | optional `JEVTRACE_API_KEY` | `jev-latest` unless overridden | `JEVTRACE_ENDPOINT` |

`JEVTRACE_MODEL` overrides the provider's default model and `JEVTRACE_ENDPOINT` overrides its endpoint. A custom endpoint must implement the TypeSafe/System One `state + questions -> answers` contract. OpenRouter uses its Decisions API, while TypeSafe, Vercel, and custom presets use System One-compatible endpoints; JevTrace normalizes their shared Noul answer shape. This does **not** mean arbitrary chat LLMs are supported yet; alternate generative-model judges need a separate score/calibration policy.

```bash
# OpenRouter (default)
OPENROUTER_API_KEY=... jevtrace query ...

# TypeSafe direct
TYPESAFE_API_KEY=... jevtrace query ... --provider typesafe --model jev-1.13

# Vercel AI Gateway
AI_GATEWAY_API_KEY=... jevtrace query ... --provider vercel

# OpenCode Zen (use --model jev-1.13-free for the free variant when available)
OPENCODE_API_KEY=... jevtrace query ... --provider opencode
```

Useful evaluation commands:

```bash
npm run bench                 # synthetic suite with current defaults
npm run bench:rounds          # per-frontier candidate/payload/latency trace
npm run bench:thresholds      # body-threshold sweep
npm run bench:stability       # cold-score stability
npm run bench:batch-sizes     # provider batching diagnostic
npm run bench:real-suite -- --offline --output benchmarks/results/real-offline-results.json
npm run bench:real-suite -- --provider openrouter --repeats 3 --output benchmarks/results/real-ablation-results.json
npm run bench:stage4-sweep -- --provider openrouter --repeats 3 --budgets 2000,4000,6000,8000 --output benchmarks/results/stage4-sweep.json
```

### From jevgrep companion to JS/TS superset

JevTrace now has a task-only path with three conceptual stages. **(1) Lexical-assisted semantic discovery:** local BM25F/exact/path retrieval runs alongside Jev repository-structure discovery, but lexical results are best treated as cheap guidance rather than as the ceiling for Jev. **(2) Compiler shallow expansion:** Jev semantic leads get one-hop caller/callee/import/type/test expansion with per-lead fan-in/token caps and neighborhood merging. **(3) Conditional final ranking:** if the compiler neighborhood fits the final budget, it can be returned directly; when it does not fit, Stage 4 Jev rescoring can recover required context that structural ordering misses. The implementation still exposes the full lexical final merge for comparison and fallback, but current development ablations found no recall gain from unconditionally dumping the lexical top-k into the final pool on the four source-reviewed cases.

Existing jevgrep leads remain supported:

```bash
jg "Where is refresh token validation implemented?" .
# Suppose jg reports a reading lead in src/auth.ts around line 42.
jevtrace query --root . --task "Fix refresh token validation" --file src/auth.ts --line 42
```

The `--evidence` option is JevTrace's own structured lead format for integrations that already have machine-readable `{ path, leads[] }` data; it should not be confused with jevgrep's current stdout format.

The intended superset is specifically **JS/TS-specialized**, not a claim that a compiler-backed tool should replace generic retrieval for every language. JevTrace aims to combine:

- repository discovery from a natural-language coding task;
- TypeScript-aware symbol and project resolution;
- typed forward dependencies plus caller/test references;
- bounded supporting context derived from compiler-resolved local constants and types;
- Jev relevance filtering over compiler-produced candidates;
- frontier batching and caching to minimize remote decision round trips;
- structured paths, omissions, unresolved references, and budget/depth warnings for coding agents.

Example MCP host configuration:

```json
{
  "mcpServers": {
    "jevtrace": {
      "command": "npx",
      "args": ["-y", "jevtrace", "--root", "/absolute/project"],
      "env": { "OPENROUTER_API_KEY": "your-key" }
    }
  }
}
```

The repository also ships an [agent skill](skills/jevtrace/SKILL.md) describing when to call the tool and how to inspect incomplete results.

## MCP input

`retrieve_dependency_context` accepts `task` alone for discovery, or `task` with one of:

- `file` plus `line` (optional `endLine`)
- `file` plus `symbol` as a compatibility fallback
- `evidence: { path, leads: [{ name, range: { startLine, endLine }, score }] }`, JevTrace's structured lead format. The highest-scoring lead is used.

`discover_entries` exposes both parallel discovery paths without running compiler expansion or final context selection. It returns `lexicalCandidates` from the local RRF retriever, `directoryLeads` from Jev tree-level scope selection, `fileLeads` from files inside the selected scopes, and diversity-selected `semanticLeads` from symbols inside those files. Both tools accept `maxCandidates` (default 64), `maxLeads` (default 4), `maxFiles` (default 3000), `maxRelevantDirectories` (default 8), `maxJevFiles` (default 256 after directory selection), and `maxRelevantFiles` (default 8). Lexical hints are visible to Jev but never restrict the semantic search space. Semantic thresholds remain provisional and have not been calibrated on a held-out real-task set.

For task-only retrieval, `tokenBudget` (default 8000 estimated tokens) is the final coding-agent context budget. `perLeadNodeLimit` (default 24), `perLeadTokenBudget` (defaulting to the final budget), `reverseFanIn` (default 12), and `neighborhoodTokenBudget` (default twice the final budget) bound compiler expansion before remote context ranking. The default final pool is now the compiler neighborhood; lexical candidates still guide discovery but are not merged into the final pool unless explicitly enabled (`--lexical-final-merge` in the CLI or `includeLexicalParallel=true` over MCP). `contextRanking=jev` calls Stage 4 only when that final pool exceeds `tokenBudget`; `contextRanking=structural` disables Stage 4. Explicit file/line retrieval retains the older `maxDepth`, `maxNodes`, threshold, reverse, wrapper-lookahead, and visit-policy controls.

## Architecture

0. **Lexical-assisted repository discovery:** Scan supported JS/TS files for callable declarations and cache compiler-derived fields. Local retrieval computes BM25F over symbol name, path, signature, referenced identifiers, and literals, then fuses that with exact and path matching through reciprocal-rank fusion. Jev independently scores repository directory scopes, files inside selected scopes, and symbols inside selected files. Lexical top results may be supplied as hints, but they never constrain Jev's candidate space. `maxJevFiles` applies after semantic directory selection, not before it. If there is only one possible directory scope, JevTrace now selects it directly instead of paying for a redundant directory-ranking call.

1. **Diverse semantic leads:** JevTrace keeps up to four qualifying Jev symbol leads rather than forcing one canonical entry. A best-effort diversity rule compares one-hop compiler neighborhoods and suppresses candidates whose local graph substantially overlaps an already selected lead, allowing later candidates to add structural coverage.
2. **Compiler shallow expansion:** Each Jev semantic lead is resolved with the TypeScript `Program`, `TypeChecker`, and `LanguageService`. JevTrace collects one-hop calls, methods, constructors, JSX, imports/types, callers, and tests, follows import aliases across files, caps reverse fan-in, then merges duplicate nodes across leads. Repeated ablations on the current development set show that this stage is doing substantive recovery rather than cosmetic expansion.
3. **Conditional final ranking:** The compiler neighborhood is the primary final-context candidate set. If it fits `tokenBudget`, another Jev call is unnecessary. If it exceeds the budget, Stage 4 can rescore candidates on a common final-context usefulness scale before the budget cut. The current implementation still supports merging lexical RRF candidates into the final pool and currently blends Jev/structural scores at 70/30, but both choices are provisional: development ablations favored lexical hints over unconditional final merging, and the Stage 4 sweep showed that the current weight can sometimes override strong structural evidence.
4. **Explicit-entry compatibility path:** Supplying a file/line still uses the older iterative dependency retriever with depth/node thresholds, body/signature/omitted decisions, wrapper lookahead, and optional Choice traversal. This path remains useful when an agent already has a trusted entry location.
5. **Structured result:** Task-only results expose `lexicalCandidates`, Jev `directoryLeads` and `fileLeads`, diversity-selected `semanticLeads`, the capped compiler `neighborhood`, the final `rankingPool`, whether conditional context ranking ran, final context/omissions, provider traces, unresolved references, and pruning warnings. These fields let evaluation attribute failures to lexical retrieval, Jev directory/file discovery, semantic lead selection, compiler expansion, lexical merging, or final budget ranking instead of only reporting end-to-end recall.

`LanguageAdapter` and `RelevanceJudge` are separate interfaces. Provider routing is configured independently with `JEVTRACE_PROVIDER` (`openrouter`, `typesafe`, `vercel`, `opencode`, or `custom`) and `JEVTRACE_MODEL`; OpenRouter remains the default for backward compatibility. Built-in providers expose the same `state + questions -> answers` decision shape to JevTrace, so transport selection does not change retrieval logic. `JEVTRACE_JEV_BATCH_SIZE` controls the local provider batch cap and defaults to 16. Legacy `JEVTRACE_JUDGE=openrouter-jev|jev|include-all` remains accepted for compatibility, while `--offline` or `include-all` bypasses remote judging. The MCP process holds a bounded in-memory digest cache of successful Jev answers, limits concurrent provider requests to four, retries one transient provider or network failure, and propagates MCP cancellation. Non-2xx responses preserve useful provider details instead of only the status code. The task, entry source, candidate source, call-site metadata, and bounded supporting snippets are sent to the selected provider.

Static analysis is incomplete for dynamic imports, dependency injection, callback invocation, and `any`-driven dispatch. A `complete` status means the configured traversal finished without recorded gaps; it is not a proof that all runtime dependencies were found. `findReferences` can still be expensive in a large project and may miss references outside the selected TypeScript project.

## Evaluation

Detailed synthetic experiments are documented in [docs/evaluation.md](docs/evaluation.md). The repeated task-only real-repository ablations and Stage 4 pressure study are documented in [docs/discovery-evaluation.md](docs/discovery-evaluation.md). Synthetic and development-set results are not evidence of general real-world coding-agent success.

### Recorded synthetic baseline

With the calibrated `bodyThreshold=0.3` / `omitThreshold=0.3` policy, the current eight-case synthetic run with the enriched supporting-context payload matches the hand-authored oracle on every case:

| Method | Precision | Recall | Required-level recall | Avg. context tokens |
| --- | ---: | ---: | ---: | ---: |
| static-all | 65.1% | 100% | 100% | 203.75 |
| oracle-filter | 100% | 100% | 100% | 168.50 |
| Jev score | 100% | 100% | 100% | 168.50 |

That run reduced dependency context by **17.3% versus static-all** without losing labeled required context. This is a synthetic-fixture result, not an agent-cost result. Threshold calibration over five cold runs showed gold scores separated from labeled noise at the 0.3 omit boundary in that fixture suite; the default remains provisional.

### Repeated real-task development benchmark

The current source-reviewed real-task suite contains two Ky tasks and two jevgrep-core tasks. All four are marked **development** rather than holdout because they have already influenced JevTrace's design. Three cold repeats produced the following required-level recall at the 8k final budget:

| Method | Retry-After | Timeout cleanup | Cache validation | Selection/evidence |
| --- | ---: | ---: | ---: | ---: |
| Full pipeline | 100% | 100% | 100% | 100% |
| Lexical-only + compiler | 100% | 100% | 100% | 66.7% |
| No Stage 4 | 100% | 100% | 100% | 100% |
| No lexical final merge, lexical hints retained | 100% | 100% | 100% | 100% |
| Pure Jev + compiler, no lexical hints/final merge | 100% | 100% | 100% | 66.7% |
| Jev leads only, no compiler expansion | 75% | 50% | 33.3% | 66.7% |

The compiler ablation is the clearest result: Jev leads alone recovered only 33.3%–75% of the labeled minimum, while one-hop compiler expansion raised three of four cases to 100%. Removing the final lexical merge also preserved 100% recall across these development cases while sharply shrinking some ranking pools; for jevgrep cache validation the pool fell from about 27k estimated tokens to about 6.1k.

A separate Stage 4 sweep replayed identical ranking pools under tighter budgets:

| Budget | Structural-only recall | Jev-ranked recall | Delta |
| ---: | ---: | ---: | ---: |
| 2k | 72.9% | 68.8% | -4.2 pp |
| 4k | 72.9% | 83.3% | +10.4 pp |
| 6k | 83.3% | 100.0% | +16.7 pp |
| 8k | 100.0% | 100.0% | 0.0 pp |

This shows that Stage 4 has real value under moderate budget pressure, but not as an unconditional reranker. The current 70/30 semantic/structural blend is still provisional: it promoted useful supporting context such as normalizeRetryOptions and TimeoutError, but in the selection/evidence case it also pushed evidenceRequest from structural rank 1 to Jev rank 6. Full methodology, provider-cost breakdown, task-leakage audit, and historical baselines are in [docs/discovery-evaluation.md](docs/discovery-evaluation.md).

The development evidence currently points toward a leaner task-only architecture: **lexical-assisted Jev discovery → compiler shallow expansion → conditional Stage 4 ranking**. The full lexical final merge and structural-only modes remain available for ablation/fallback until larger holdout evaluation exists.


### Historical first real-repository baseline: Ky

The first valid real-repository run used [sindresorhus/ky](https://github.com/sindresorhus/ky) with the task `Change how HTTP 429 retry delay is calculated from Retry-After`, starting from `Ky.#calculateRetryDelay`. After fixing `maxDepth` to be a hard bound and removing evaluation node/token caps, the recorded comparison was:

| Ky run | Included dependencies | Context tokens | Context reduction | Dependency-count reduction |
| --- | ---: | ---: | ---: | ---: |
| static-all | 35 | 5,049 | — | — |
| Jev, candidate-only payload | 11 | 2,152 | 57.4% | 68.6% |
| Jev, enriched supporting context | 14 | 3,591 | 28.9% | 60.0% |

The first Jev run used two provider requests and completed in about 0.78s. After enriching the relevance payload with entry source plus checker-derived supporting constants/types, the same task still used two provider requests and completed in about 0.96s; total provider payload grew from roughly 21.2 KB to 35.9 KB. The richer context therefore reduced compression, but `normalizeRetryOptions` moved from a Jev relevance score of **0.22** to **0.51**, crossing the default 0.3 inclusion boundary once Jev could see the retry defaults and related local context. This is evidence that supporting context can materially improve an individual relevance decision, with an explicit context-size and payload tradeoff. Both runs remained `incomplete` because static resolution had unresolved references and traversal intentionally stopped at `maxDepth=2`. There is not yet a hand-authored real-world gold set, so this remains a single-task descriptive result rather than a precision/recall benchmark.

### Current relevance payload

The real-repository run exposed a failure mode that the synthetic fixtures did not: a candidate such as `normalizeRetryOptions` can look generic when Jev sees only its own body, even though same-file constants such as retry status-code defaults materially explain its role. Current Jev requests therefore include:

```text
task
entry: signature + bounded body
relationship: edge kind + depth + call site
candidate: signature + bounded body
supporting context: checker-resolved same-file constants/types, max two local hops
```

Supporting context is deliberately bounded rather than expanding another full graph. The goal is to improve relevance decisions while preserving JevTrace's small-context design.

### Latency observations

Frontier batching reduces a depth-two traversal to two relevance rounds. Round-level instrumentation records candidate count, payload bytes, provider batches/requests, cache hits, and latency. Similar-sized OpenRouter/Jev requests have shown substantial tail-latency variation across runs, so provider latency is treated as an observed external variable rather than evidence that smaller local batches are better. `bench:batch-sizes` remains a diagnostic, not the default optimization strategy.

The [real-task suite](docs/discovery-evaluation.md) measures the task-only pipeline path by path: lexical strict/soft recall@64, Jev semantic-lead graph distance, compiler-neighborhood recovery, ranking-pool pressure, final required-level recall, compactness, provider requests, and directory/file/symbol latency. Repeated ablations now isolate lexical-only retrieval, Stage 4 removal, final lexical-merge removal, pure Jev discovery without lexical hints, and Jev leads without compiler expansion. The separate Stage 4 sweep replays identical pools under 2k/4k/6k/8k budgets. Because the labels specify only minimum required context, the suite does **not** claim true precision; `minimumRequiredDensity` remains a compactness lower-bound signal. The four current real tasks are development data rather than holdout evidence; automated jevgrep comparison and end-to-end agent success/cost measurement remain future work.

DyRetriever's published ablation is motivation for this setup, not a result for JevTrace: removing multi-hop reduced Pass@1 by 6.0%–9.6%, while removing all of DyRetriever reduced it by 15.7%–51.1% in the reported configurations. Removing similarity retrieval reduced it by 6.5%–23.8%. Those experiments generated functions on CoderEval/DevEval; this project targets existing-code changes, where tests and callers may be more useful. See [the paper's ablation table](https://arxiv.org/html/2608.01927v1).

## License

MIT
