# Evaluation Notes

This document records the **early synthetic evaluation of JevTrace's known-entry dependency-retrieval subsystem**. These results are synthetic and local to the benchmark fixtures. They remain useful for validating compiler traversal, relevance scoring, context-detail policy, and provider batching, but they no longer describe the full product architecture. Current task-only repository discovery, compiler expansion, Stage 4 ranking, and real-repository ablations are evaluated separately in [discovery-evaluation.md](discovery-evaluation.md).

## What is being evaluated

The experiments in this file start from a known JS/TS entry point, resolve a partial dependency graph with the TypeScript compiler, and use Jev to filter task-relevant dependencies. This is now the explicit-entry compatibility path inside the broader JevTrace superset, not the only way JevTrace operates.

This synthetic evaluation separates three questions:

1. **Graph recall:** can static analysis reach the manually labeled dependencies?
2. **Jev filtering:** can Jev remove irrelevant static candidates without dropping relevant ones?
3. **Context policy:** once a dependency is judged relevant, should JevTrace return its body, only its signature, or omit it?

The synthetic suite currently contains eight tasks covering imports, multi-hop calls, typed methods, constructors, branching, wrappers, and small dependency pipelines.

## Baselines and metrics

The benchmark compares:

- **entry-only** — return only the starting declaration.
- **static-all** — include every statically resolved candidate.
- **oracle-filter** — synthetic upper bound that knows the gold dependency labels.
- **jev-score** — use Jev Noul scores to filter and choose context detail.

Reported metrics:

- **Precision** — fraction of retrieved dependency symbols that are gold.
- **Recall** — fraction of gold dependency symbols retrieved at any non-omitted level.
- **Required recall** — fraction of gold dependencies returned at the required context level. A body satisfies both body and signature requirements; a signature does not satisfy a body requirement.
- **Context tokens** — estimated context size using the project's current character-based token estimate.
- **Relevant / 1K tokens** — number of retrieved gold dependencies per 1,000 estimated context tokens.
- **Latency** — wall-clock retrieval latency. Provider latency and in-memory cache state can dominate this number, so cold and warm measurements are kept separate.
- **Judge rounds** — number of relevance-judging frontiers sent to the judge.

## 1. Clean smoke test

The first smoke fixture intentionally contained only relevant dependencies.

| Method | Recall | Precision | Tokens |
| --- | ---: | ---: | ---: |
| entry-only | 0% | 0% | 29 |
| static-all | 100% | 100% | 85 |

This test only verified the evaluator and graph traversal. Because every static candidate was relevant, it could not measure filtering quality.

## 2. Noisy single-case smoke test

A noisy refresh-token fixture added irrelevant logging, metrics, and audit calls alongside the actual authentication flow.

The static graph contained eight dependency candidates, of which five were labeled relevant.

| Method | Recall | Precision | Required recall | Tokens |
| --- | ---: | ---: | ---: | ---: |
| entry-only | 0% | 0% | 0% | 64 |
| static-all | 100% | 62.5% | 100% | 217 |
| oracle-filter | 100% | 100% | 100% | 165 |
| jev-score | 100% | 100% | 80% | 157 |

Jev removed all three irrelevant candidates while retaining all five relevant symbols. The required-level miss came from returning one relevant function as a signature instead of a body.

This established an important distinction: **symbol recall can remain perfect even when the context-detail policy is too aggressive.**

## 3. Eight-case synthetic benchmark

The suite was expanded to eight tasks:

- noisy refresh-token flow
- session invalidation
- failed-payment retry
- permission checking
- message processing
- avatar upload
- feature flags
- product search

With the original context policy of body > 0.7, signature >= 0.3, and omit < 0.3, one representative aggregate run produced:

| Method | Precision | Recall | Required recall | Avg. tokens |
| --- | ---: | ---: | ---: | ---: |
| static-all | 65.1% | 100% | 100% | 203.75 |
| oracle-filter | 100% | 100% | 100% | 168.50 |
| jev-score | 100% | 100% | 71.5% | 155.00 |

The Jev filter preserved symbol recall while removing all labeled noise, but the 0.7 body threshold compressed too many relevant dependencies to signatures.

A later repeated run with the same policy produced 74.0% required recall and 156.25 average tokens. The variation came from fresh Jev scores, which motivated the stability experiment below.

## 4. Body-threshold sweep

The omit threshold was held fixed at 0.3 while the body threshold varied.

A single-process sweep gave:

| Body threshold | Precision | Recall | Required recall | Avg. tokens |
| ---: | ---: | ---: | ---: | ---: |
| 0.3 | 100% | 100% | 100% | 168.50 |
| 0.4 | 100% | 100% | 100% | 168.50 |
| 0.5 | 100% | 100% | 96.9% | 166.75 |
| 0.6 | 100% | 100% | 79.0% | 159.00 |
| 0.7 | 100% | 100% | 74.0% | 156.25 |
| 0.8 | 100% | 100% | 48.3% | 145.13 |

The main observation was that increasing the body threshold above roughly 0.4–0.5 saved relatively few tokens while sharply reducing required-level recall.

Based on this sweep and the cold stability experiment below, the v0.1 runtime default was changed from 0.7 to **0.3** for `bodyThreshold`, while `omitThreshold` remains **0.3**. This is a provisional default calibrated on the synthetic suite, not a claim that 0.3 is universally optimal.

## 5. Five-run cold stability experiment

To check whether a good-looking threshold result was caused by one favorable Jev response, the eight cases were repeated five times with a **fresh Jev judge per run**.

The benchmark collected a fixed depth-two static graph independently of the production thresholds and then applied threshold policies offline.

### Score distribution

| Label | Observations | Mean | Std. dev. | Min | Max |
| --- | ---: | ---: | ---: | ---: | ---: |
| gold | 165 | 0.769 | 0.132 | 0.350 | 0.920 |
| noise | 90 | 0.096 | 0.045 | 0.050 | 0.250 |

Observed separation:

~~~text
min(gold)  = 0.350
max(noise) = 0.250
margin     = 0.100
~~~

Across these five cold runs, **0 of 51 distinct candidates crossed the 0.3 omit threshold**. Every observed gold candidate stayed at or above 0.3, and every observed noise candidate stayed below it.

The most variable gold candidate was normalizeRules, ranging from 0.35 to 0.47. The highest-scoring observed noise candidate, auditRefresh, ranged up to 0.25.

### Offline body-threshold sweep across all cold runs

| Body threshold | Precision | Recall | Required recall | Avg. tokens |
| ---: | ---: | ---: | ---: | ---: |
| 0.3 | 100% | 100% | 100% | 168.50 |
| 0.4 | 100% | 100% | 98.1% | 167.45 |
| 0.5 | 100% | 100% | 96.9% | 166.75 |
| 0.6 | 100% | 100% | 84.5% | 161.80 |
| 0.7 | 100% | 100% | 73.3% | 155.93 |
| 0.8 | 100% | 100% | 51.0% | 145.93 |

Within this synthetic suite, 0.3 is the strongest observed body threshold if preserving all required bodies is the priority. Moving from 0.3 to 0.4 saves only about one estimated token per case on average while already losing some required-level recall.

This does **not** establish 0.3 as a generally optimal production threshold. The fixtures and labels are synthetic and intentionally clear.

### Cold provider latency

Five full cold runs over all eight cases took:

~~~text
4.31s
4.39s
4.03s
3.90s
4.15s
~~~

Mean wall time was **4.16s** for eight cases, with a range of **3.90–4.39s**.

## 6. Frontier batching experiment

The original retriever could call the relevance judge while expanding individual queued nodes. It was refactored to collect a dependency frontier and judge that frontier together.

The Jev judge was also changed so frontiers larger than 16 candidates are split into 16-candidate provider batches and those batches can run concurrently, subject to the existing concurrency cap.

After the change, every depth-two synthetic retrieval completed in exactly:

~~~text
judgeRounds = 2
~~~

This confirms the intended structural change: one relevance round for depth one and one for depth two.

### Post-batching benchmark

The benchmark below still used the old body > 0.7, omit < 0.3 context policy.

| Method | Precision | Recall | Required recall | Avg. tokens | Avg. judge rounds | Avg. latency |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| static-all | 65.1% | 100% | 100% | 203.75 | 2 | 5.05 ms |
| oracle-filter | 100% | 100% | 100% | 168.50 | 2 | 2.04 ms |
| jev-score | 100% | 100% | 76.5% | 157.63 | 2 | 5303.41 ms |

The structural batching goal succeeded, but provider latency remained highly variable. A later round-level trace showed that first-frontier requests with similar sizes (roughly 3.2–4.9 KB and 4–6 candidates) ranged from about 0.21s to 4.26s, while the smaller second-frontier requests were generally about 0.21–0.49s. In that trace every frontier fit in a single provider batch, so the variation was not caused by the local 16-candidate split.

Therefore, reducing judge rounds alone is **not sufficient evidence of lower end-to-end latency**. The instrumentation remains in the retrieval result so provider tail latency can be observed, but batch-size tuning is treated as a diagnostic rather than the primary optimization path.

## Current interpretation

The synthetic experiments support the following narrow conclusions:

1. The TypeScript static graph reaches all manually labeled dependencies in the current suite.
2. Jev cleanly separated the labeled relevant and irrelevant candidates in these fixtures.
3. The original 0.7 body threshold is too aggressive for the current suite; most quality loss comes from body-to-signature downgrades, not from omitting relevant symbols.
4. The 0.3 omit boundary was stable across five cold runs in this synthetic setup.
5. Frontier batching reduced the retrieval structure to two relevance rounds for depth-two tasks.
6. Provider tail latency remains an open performance issue and is not explained by judge-round count alone.

## What these results do not establish

These experiments do **not** yet show that JevTrace:

- improves coding-agent task success,
- reduces total agent cost on real repositories,
- outperforms jevgrep,
- generalizes the observed 0.3 relevance separation to real code,
- or has consistently low provider latency.

The current product positioning is no longer a sequential "jevgrep then JevTrace" pipeline. JevTrace now implements its own task-only repository discovery and is being built as a **JS/TS-specialized superset of jevgrep's repository-retrieval role**: semantic discovery is combined with TypeScript compiler structure and budget-aware context construction in one tool.

~~~text
jevgrep
  semantic repository discovery
  task -> relevant files / code locations

JevTrace
  lexical-assisted semantic repository discovery
      -> Jev directory/file/symbol leads
      -> TypeScript compiler caller/callee/import/type/test expansion
      -> bounded implementation context
      -> conditional Stage 4 ranking under token pressure
~~~

The overlap is deliberate: both tools address semantic repository discovery. JevTrace's differentiator is that, for JS/TS, discovery is only the first stage of a compiler-native retrieval pipeline rather than an external prerequisite. A known file/line can still bypass discovery as a compatibility path, but JevTrace does not require a jevgrep lead to operate.

The useful future product comparison is therefore **jevgrep versus JevTrace as standalone task-to-context retrievers** on real JS/TS coding tasks. Evaluation should measure discovery coverage, required implementation-context recall, context size, provider cost/latency, and ultimately coding-agent task success. A chained `jevgrep -> JevTrace` workflow can remain an interoperability scenario, but it is no longer the primary product framing.

## Reproducing the current synthetic experiments

~~~bash
npm test
npm run bench:smoke
npm run bench
npm run bench:verbose
npm run bench:thresholds
npm run bench:stability
npm run bench:rounds
npm run bench:batch-sizes
~~~

`bench:rounds` is a provider-latency diagnostic. `bench:batch-sizes` is retained as a diagnostic microbenchmark rather than a production tuning target; Jev is designed to evaluate independent questions together, so JevTrace's normal architecture keeps same-depth candidates batched by frontier. The benchmark scripts use .env for OPENROUTER_API_KEY.
