# Task-only discovery and real-task evaluation

The default task-only path is now `task -> lexical-assisted Jev discovery -> diverse Jev leads -> compiler shallow expansion -> conditional Jev/structural ranking -> coding-agent context`. Lexical retrieval guides Jev discovery but is not unconditionally dumped into the final pool; the old full lexical final merge remains available as an explicit compatibility/ablation option. An explicit file/line bypasses this pipeline and uses the compatibility dependency retriever. `discover_entries` (MCP) or `jevtrace discover` (CLI) exposes discovery without expanding the final context.

The local lexical retriever uses BM25F over symbol names, signatures, paths, referenced identifiers and literals, fused with exact-match and path-match rankings through reciprocal-rank fusion. Jev separately sees the repository tree, scores directory scopes, scores files inside the selected scopes, then scores symbols inside the selected files to produce 2–4 diverse semantic leads. Lexical top results can be supplied as hints but lexical misses do not bound the Jev path. `maxJevFiles` is applied after directory selection rather than as a repository-wide lexical/sample funnel. If only one directory scope exists, JevTrace now selects it directly and skips the redundant remote directory-ranking call. Compiler expansion then resolves one-hop forward/reverse relationships around Jev leads with per-lead and total neighborhood caps. By default that compiler neighborhood becomes the final ranking pool; lexical final merging can still be enabled explicitly, and Stage 4 Jev ranking runs only when the chosen pool exceeds the final budget.

## Pinned source-reviewed cases

`benchmarks/real-cases.json` defines four investigation tasks and minimum required context, labeled from the source before semantic evaluation:

| Repository scope | Task | Required context |
| --- | --- | --- |
| Ky source project | HTTP 429 Retry-After timing | Retry owner, retry normalization, header selection and timing parser |
| Ky source project | Timer cleanup after synchronous fetch failure | Timeout implementation and timeout error contract |
| jevgrep core sources | Expired/corrupt cache entries | Cache factory, answer validation and missing-file classification |
| jevgrep core sources | Overlapping selected ranges and declaration evidence | File selection, span merging and evidence request construction |

Ky is pinned to `0d59458a0a58e1c3d7c6db0ab17ed5c7cd671e47`; jevgrep to `adbea4cc8560725f36a5f4bb8cc6fcce87d78185`. Paths in the manifest are relative to the manifest file. The runner checks revisions, rejects tracked changes and verifies declaration labels before provider calls. These are source-reviewed investigation tasks, not independently curated issue/patch gold or a held-out benchmark. Labels include rationales and may need independent review.

The jevgrep scope is explicitly `packages/core/src`: the local checkout lacks the workspace package needed by its tsconfig `extends`. With this source directory as the root, JevTrace uses inferred Bundler/ESNext resolution for local extensionless imports. This measures the core source subset, not monorepo project-reference support; external package resolution may remain incomplete. Ky uses its installed project configuration.

## Run

```bash
npm run bench:real-suite -- --offline --output benchmarks/results/real-offline-results.json
npm run bench:real-suite -- --provider openrouter --repeats 3 --output benchmarks/results/real-ablation-results.json
npm run bench:real-suite -- --provider openrouter --case ky-retry-after
npm run bench:stage4-sweep -- --provider openrouter --repeats 3 --budgets 2000,4000,6000,8000 --output benchmarks/results/stage4-sweep.json
```

The online mode sends code candidates to the configured provider and uses its API quota. `--manifest` selects another case set, `--model` overrides the model, `--repeats N` creates fresh judges for repeated cold runs, and `--details` includes full retrieval results in the saved output. `--split development|holdout|all` supports a future untouched holdout set. The four current cases are explicitly marked `development`; they have already informed design decisions and must not be presented as final held-out evidence. Default saved output contains metrics and compact diagnostics. Credentials are never part of the report.

Modes:

- `static-known-entry`: labeled entry, all resolved forward dependencies; compatibility baseline.
- `jev-known-entry`: labeled entry, old Jev dependency filtering; compatibility baseline.
- `pipeline-baseline`: parallel lexical RRF + Jev file-tree/symbol discovery, compiler expansion, lexical/compiler merge, conditional Jev+structural ranking.
- `pipeline-lexical-only`: lexical top-k leads + compiler reverse/forward expansion with structural budget cutting; no Jev calls.
- `pipeline-no-stage4-jev`: full parallel discovery and compiler expansion, but final budget cutting uses structural priors only.
- `pipeline-no-lexical-final-merge`: Jev discovery still receives lexical hints, but lexical RRF candidates are not merged into the final pool. This isolates the final-merge contribution and must not be described as removing the whole lexical path.
- `pipeline-pure-jev`: removes both lexical hints from Jev directory/file discovery and lexical candidates from the final merge, while retaining compiler shallow expansion. This is the actual no-lexical-path ablation.
- `pipeline-jev-leads-only`: keeps Jev semantic discovery but disables compiler expansion and lexical final merge, measuring how much the compiler recovers beyond the selected leads themselves.

Metrics are reported by stage/path. The lexical branch reports **strict recall@64** (the required symbol itself is present) and **soft recall@64** (the required symbol or a one-hop compiler neighbor is present), with strict/soft miss lists. The Jev branch reports selected semantic-lead graph distance to the required set (within one and two hops). Compiler expansion reports required-context recall plus raw/capped neighborhood symbol and token counts before lexical merging. Final output reports required-level recall, returned token footprint, ranking-pool tokens, budget pressure, provider requests and latency. Discovery provider work is split into directory/file/symbol request and latency totals so Stage 2 can be optimized from measurements rather than assumptions. Because the real-task manifest labels only minimum required context, it cannot establish true precision; `minimumRequiredDensity` remains a compactness lower-bound signal rather than a precision claim.

Reverse traversal is deliberately one hop per semantic lead. `reverseFanIn` defaults to 12; per-lead node/token bounds prevent one seed from monopolizing the neighborhood, and `neighborhoodTokenBudget` caps the merged graph before conditional Stage 4. The real suite currently uses a final pipeline budget of 8,000 estimated tokens and a pre-ranking neighborhood cap of 16,000 while keeping the historical known-entry runs effectively uncapped for comparison.


## Repeated development benchmark results

The current four real-repository cases were run three times with fresh judges. These cases are **development data**: they have already influenced JevTrace's architecture and must not be treated as an untouched holdout benchmark. The purpose of the repeated runs is to separate the contribution of lexical retrieval, Jev discovery, compiler expansion, and final context ranking before changing the implementation.

### End-to-end ablation

Required-level recall at the 8,000-token final budget:

| Method | Ky Retry-After | Ky timeout | jevgrep cache | jevgrep selection/evidence |
| --- | ---: | ---: | ---: | ---: |
| Full pipeline baseline | 100% | 100% | 100% | 100% |
| Lexical-only + compiler | 100% | 100% | 100% | 66.7% |
| No Stage 4 Jev | 100% | 100% | 100% | 100% |
| No lexical final merge, lexical hints retained | 100% | 100% | 100% | 100% |
| Pure Jev discovery + compiler, no lexical hints/final merge | 100% | 100% | 100% | 66.7% |
| Jev leads only, no compiler expansion/final merge | 75% | 50% | 33.3% | 66.7% |

The strongest result is the compiler ablation. Jev leads by themselves recovered only 33.3%–75% of the minimum required context, while adding one-hop compiler expansion raised three of the four cases to 100%. In the selection/evidence case the compiler neighborhood itself reached 100% recall even when the final context fell to 66.7%, showing that the remaining failure occurred after compiler recovery rather than in graph expansion.

The lexical ablations separate two different roles. Removing only the **final lexical merge** preserved 100% required-level recall on all four development cases while substantially shrinking some ranking pools. For example, the jevgrep cache pool fell from about 27,042 estimated tokens in the full baseline to 6,136 tokens without changing recall. Removing lexical hints from Jev discovery as well produced the pure-Jev path; that path remained at 100% on three cases but fell to 66.7% on selection/evidence. This is evidence, on the current development set, that cheap lexical retrieval is more clearly useful as **guidance for semantic discovery** than as an unconditional final-context candidate dump.

This does not establish that the final lexical merge is universally unnecessary. A holdout case where Jev discovery misses a required symbol but lexical retrieval finds it could reverse that conclusion. The current result is therefore used as an implementation direction, not a general claim.

### Stage 4 under budget pressure

Stage 4 was tested separately by scoring one identical merged ranking pool with Jev and replaying that same pool under 2k, 4k, 6k, and 8k final budgets. This isolates final ranking from discovery and compiler differences. Each case was repeated three times.

| Final budget | Structural-only recall | Jev-ranked recall | Mean delta | Win / tie / loss |
| ---: | ---: | ---: | ---: | ---: |
| 2,000 | 72.9% | 68.8% | -4.2 pp | 1 / 8 / 3 |
| 4,000 | 72.9% | 83.3% | +10.4 pp | 4 / 8 / 0 |
| 6,000 | 83.3% | 100.0% | +16.7 pp | 5 / 7 / 0 |
| 8,000 | 100.0% | 100.0% | 0.0 pp | 0 / 12 / 0 |

Stage 4 was genuinely exercised: the ranking pools were about 1.5x–3.4x the 8k budget and 6.0x–13.5x the 2k budget. Its value is therefore conditional rather than absent. At moderate pressure (4k–6k) Jev ranking recovered required context that structural ordering missed. At 8k it added no recall on these cases. At the extreme 2k budget it sometimes hurt, most clearly on selection/evidence.

Required-target ranks explain both the benefit and the failure mode. Jev moved normalizeRetryOptions from an average structural rank of 25.0 to 9.3 and TimeoutError from 34.3 to 13.7. In contrast, it moved evidenceRequest from rank 1.0 to 6.0 while promoting selectFile and mergeSpans. The current 0.7 semantic + 0.3 structural blend is therefore still provisional: Stage 4 has demonstrated value, but its weight can override strong structural evidence too aggressively.

### Provider cost and latency

Stage 4's multiple HTTP requests are explained by the local Jev batch cap rather than retries. With the default batch size of 16, pools of 41–83 candidates produced 3–6 Stage 4 batches; the repeated Stage 4 experiment observed zero retries. Stage 4 wall latency was roughly 0.29–0.58 seconds per case in that run.

The repository-discovery path is currently the larger latency target. Directory, file, and symbol decisions are sequential stages, and their combined wall time was roughly 0.7–0.9 seconds on the measured cases. In the jevgrep source subset the directory stage had only one candidate yet still issued a remote decision. Skipping a semantic decision when there is exactly one possible directory is therefore a low-risk implementation optimization: it cannot change the selected directory and removes an otherwise redundant provider round trip.

### Development conclusions

The development benchmark currently supports the following narrow implementation conclusions:

1. **Compiler shallow expansion is a core part of JevTrace, not an optional refinement.** It consistently recovers required context beyond the Jev-selected leads.
2. **Lexical retrieval remains useful, but its clearest observed role is as a cheap hint to Jev discovery.** Unconditionally merging the lexical top-k into the final pool increased ranking pressure without improving recall on the current four cases.
3. **Stage 4 should remain conditional.** It can recover important context under moderate token pressure, but it has no observed recall benefit when the pool already fits and can hurt under extreme pressure with the current score blend.
4. **The leaner task-only path is now the runtime default:** lexical-assisted Jev discovery → compiler expansion → conditional Stage 4. The full lexical merge and structural-only modes remain available as ablations/fallbacks until holdout evaluation exists.
5. **The current results are not final generalization evidence.** The task wording audit found identifier/path overlap in some development cases. A first holdout set now exists (see below), but it has since informed two changes.

The benchmark infrastructure keeps the no-lexical-final-merge, pure-Jev, Jev-leads-only, and Stage 4 budget-sweep modes so future implementation changes can be checked against the same decomposed measurements.

## Holdout set and robustness changes

`benchmarks/holdout-cases.json` adds 15 source-reviewed `holdout` cases: 8 in [hono](https://github.com/honojs/hono) pinned at `37ce06904e732d4bc11c9075adf362c76049a594` (448 indexed files, adaptive directory scopes), 4 more in Ky and 3 more in jevgrep core. Task wording deliberately paraphrases instead of repeating identifiers, and labels were written from source before any run. Run it with `--manifest benchmarks/holdout-cases.json --split holdout`; hono is expected at `../../hono` relative to the manifest. `--modes a,b` restricts the modes, and a mode that throws is now recorded as an `error` run with zero recall instead of aborting the suite.

The baseline run on the holdout exposed a crash: the repository index listed function-valued variables nested inside test callbacks, which the compiler adapter cannot resolve, and an unresolvable lead aborted the whole retrieval. The following changes were then made (see [architecture.md](architecture.md)): index/adapter declaration consistency, type-level declarations as semantic leads (after callables, and outside lexical ranking), per-lead failure isolation and provider-failure degradation, adaptive directory scopes, lexically ordered `maxJevFiles` capping, lexical file rescue, a signature level in the final budget cut, and per-program compiler scan caching with warm tsconfig projects.

Runtime default mode (`pipeline-no-lexical-final-merge`), two cold repeats per case, OpenRouter, required-level recall at the 8,000-token budget:

| Set | Runs | Errors before → after | Recall before → after | Provider requests | Mean wall time |
| --- | ---: | ---: | ---: | ---: | ---: |
| Development (4 cases) | 8 | 0 → 0 | 100.0% → 95.8% | 5.5 → 7.8 | 1.13 s → 1.27 s |
| Holdout (15 cases) | 30 | 3 → 0 | 86.7% → 95.0% | 13.1 → 15.1 | 2.46 s → 2.38 s |

Offline (no provider), mean over `static-known-entry` and `pipeline-lexical-only`: development 95.8% → 95.8%, holdout 72.8% → 77.2% (3 crashes → 0).

Caveats:

- **The holdout is no longer untouched.** Two changes were made after seeing holdout runs: type-level declarations were removed from lexical ranking (they let large option interfaces dominate the lexical-only ablation, visible on both sets), and type-level leads were ordered after callables (they displaced needed callables in one development and two holdout runs). A large-body-starts-at-signature rule was tried and removed because it demoted jevgrep's `selectFile`. A fresh holdout is needed before claiming generalization.
- The remaining development drop is one of two `jevgrep-selection-evidence` runs (67%): in that run Jev scored `evidenceRequest` below other leads. The holdout's remaining miss (`jevgrep-credential-redaction`, one of two runs at 50%) came from larger leads pushing `EvaluationFailure` past the neighborhood cap. Two repeats cannot separate these from provider variance.
- Provider requests rose because symbol-level judging now also sees type-level declarations; wall time was roughly unchanged.

## Historical initial offline result (before reverse discovery recovery)

| Task | Labeled entry selected | Required-level recall: static known entry | Required-level recall: lexical discovery, forward-only |
| --- | --- | ---: | ---: |
| Ky Retry-After | No; in top three | 100% | 25% |
| Ky timeout cleanup | Yes | 100% | 100% |
| jevgrep cache validation | Yes | 100% | 100% |
| jevgrep selection evidence | Yes | 100% | 100% |

All four runs retain `incomplete` status due to unresolved expressions and/or traversal bounds. Perfect recall here means the small labeled minimum was retrieved; it does not mean the runtime graph is complete. The lexical Retry-After miss demonstrates why entry hit and context recall must be reported separately.

## First live Jev baselines

The first four-case online run exposed two different failure modes. Known-entry Jev retrieval preserved the full minimum required context in three of four tasks; the Ky timeout task missed the `TimeoutError` signature label. Task-only discovery selected the labeled entry for three tasks. For Ky Retry-After, the labeled owner was present in the Jev top three (`hit@3=true`) but the selected lead was `calculateRetryTimingDelay`, reducing required-level recall to 25% under the benchmark's forward-only traversal.

A follow-up experiment added a second compiler-aware Jev rerank over the top three. It did not change the Ky selection: `calculateRetryTimingDelay` remained first, while `Ky.#calculateRetryDelay` remained second. The extra decision stage increased provider requests by one and materially increased discovery latency, so it was removed from the default pipeline. Inspection also showed that the selected helper is semantically valid for the task: it calculates retry timing from server-provided headers and is called by the labeled owner. The poor end-to-end recall therefore exposed a benchmark-policy mismatch as much as an entry-ranking problem.

The current task-only path intentionally does not force one canonical entry and does not treat lexical retrieval as the ceiling for semantic discovery. Lexical RRF supplies cheap semantic hints, Jev produces multi-seed leads from repository structure, and the compiler supplies structural relationships before conditional Stage 4 ranking. The earlier single-entry reverse-recovery, top-three rerank, and unconditional lexical-final-merge experiments remain recorded above because they motivated this redesign; they are no longer the default task-only path.

The repeated cold ablations and Stage 4 pressure sweep above are complete for the current development set. JevTrace has therefore moved back into implementation work rather than expanding this benchmark before every code change. The first implementation changes from those experiments are now in place: single-directory discovery skips its redundant Jev decision, lexical final merging is opt-in rather than default, and Stage 4 remains conditional while its score blend is provisional. The existing ablation modes stay in place as regression checks. New source-reviewed cases should still be added later, with some marked `holdout`; priority holdout cases are vocabulary-mismatch tasks, tasks whose minimum required bodies strongly pressure the final budget, and materially larger JS/TS repositories. Task wording should be audited for exact identifier/path leakage before labels are frozen.
