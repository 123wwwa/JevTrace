# Benchmark: JevTrace vs jevgrep

A head-to-head **retrieval** benchmark on JavaScript/TypeScript tasks: both tools get the same natural-language task and the same repository checkout, and both are scored on the text a coding agent would actually receive.

| Metric (mean over 19 tasks) | JevTrace | jevgrep 0.7.0 |
| --- | ---: | ---: |
| Required code delivered (required-level recall) | **89.5%** | 70.6% |
| Tasks with all required code delivered | **15 / 19** | 7 / 19 |
| Tokens handed to the agent | **7,036** | 11,832 |
| Jev requests | **13.7** | 58.2 |
| Jev input tokens | **86k** | 529k |
| Jev cost per search | **$0.0036** | $0.0222 |
| Search time | **2.1 s** | 5.9 s |

Per task, JevTrace delivered more of the required code on 9 tasks, jevgrep on 1, and 9 were tied.

## Method

- **Tasks.** 19 source-reviewed tasks from `benchmarks/real-cases.json` (4 development) and `benchmarks/holdout-cases.json` (15 holdout) across three repositories: [Ky](https://github.com/sindresorhus/ky), [Hono](https://github.com/honojs/hono) (448 source files) and jevgrep's own core sources, each pinned to a commit. Each task lists the minimum declarations needed to investigate or change the behaviour, and whether the body or only the signature is required.
- **Tools.** JevTrace at its runtime defaults (task-only, 8,000-token budget, MCP text output). jevgrep `@dzhng/jevgrep@0.7.0` at its defaults (`jg --no-cache "<task>" <root>`, unlimited source), run in a Linux container because jevgrep does not support Windows. A second jevgrep configuration capped at `--max-source-bytes 32000` (about the same 8,000 tokens) reached 73.2% recall.
- **Provider.** Both tools used Jev through OpenRouter. Jev cost and input tokens come from the provider-reported `usage` of every response (Jev is billed at $0.042 per million input tokens; output is free).
- **Scoring.** One rule for both tools, applied to the delivered text: a body-level target counts when its first line and at least 90% of its lines appear in the output; a signature-level target counts when its first line appears. Tokens are characters ÷ 4 for both.
- **Timing.** Wall-clock time of one cold search. jevgrep's repositories were copied onto the container's own filesystem first; reading them through a Windows bind mount made jevgrep about three times slower (17.4 s) and was not used.

## Limitations

- **The labels were written by the JevTrace authors.** They are declaration-level, which suits a tool that expands declarations through the compiler. Most of jevgrep's misses are supporting types and error classes that it lists as reading leads without source; an agent can open those files itself, and this benchmark does not credit that.
- **Small and JS/TS-only.** 19 tasks in three repositories, one cold run each (jevgrep was run twice with the same recall). The 4 development tasks shaped JevTrace's design, and the holdout informed two later changes (see [discovery-evaluation.md](discovery-evaluation.md)). jevgrep also supports Python, Go and Rust; JevTrace does not.
- **Retrieval, not task success.** jevgrep's own published result measures end-to-end coding-agent success and cost on Python SWE-bench tasks. This benchmark does not measure whether an agent completes the task.
- **Where JevTrace lost:** `jevgrep-secret-files`, where the required context includes a module-level configuration constant; JevTrace does not yet follow references to plain values.

## Reproduce

Requires Docker, the pinned checkouts next to this repository (see the manifests) and `OPENROUTER_API_KEY` in `.env`.

```bash
npm run build
node --env-file=.env scripts/compare-jevgrep.mjs
node scripts/render-benchmark-card.mjs
```

The first command writes every tool output, usage record and `report.json` under `benchmarks/results/competitor/`; the second regenerates the README card from that report.

## Per task

| Task | Split | JevTrace recall | jevgrep recall | JevTrace tokens | jevgrep tokens | JevTrace Jev cost | jevgrep Jev cost | JevTrace time | jevgrep time |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `ky-retry-after` | development | 100% | 75% | 7,500 | 23,716 | $0.0021 | $0.0136 | 1.6 s | 3.7 s |
| `ky-timeout-cleanup` | development | 100% | 50% | 7,500 | 13,351 | $0.0028 | $0.0309 | 1.6 s | 11.8 s |
| `jevgrep-cache-validation` | development | 100% | 33% | 7,500 | 4,122 | $0.0015 | $0.0029 | 1.2 s | 1.5 s |
| `jevgrep-selection-evidence` | development | 100% | 67% | 7,500 | 4,917 | $0.0014 | $0.0080 | 1.1 s | 3.1 s |
| `hono-etag-validator-list` | holdout | 100% | 100% | 7,500 | 4,956 | $0.0037 | $0.0232 | 2.9 s | 5.1 s |
| `hono-ip-mapped-ranges` | holdout | 100% | 100% | 7,500 | 5,504 | $0.0065 | $0.0271 | 3.3 s | 6.3 s |
| `hono-token-clock-skew` | holdout | 100% | 33% | 7,500 | 4,925 | $0.0039 | $0.0277 | 2.2 s | 6.6 s |
| `hono-request-body-reuse` | holdout | 100% | 67% | 7,500 | 17,098 | $0.0074 | $0.0289 | 5.1 s | 7.7 s |
| `hono-cookie-prefix-rules` | holdout | 100% | 100% | 3,290 | 14,948 | $0.0082 | $0.0354 | 3.6 s | 8.6 s |
| `hono-deadline-dynamic` | holdout | 50% | 50% | 7,500 | 1,268 | $0.0045 | $0.0218 | 3.3 s | 5.7 s |
| `hono-csp-nonce` | holdout | 100% | 100% | 7,500 | 8,053 | $0.0068 | $0.0356 | 3.5 s | 8.6 s |
| `hono-thrown-http-response` | holdout | 100% | 50% | 5,097 | 18,029 | $0.0058 | $0.0529 | 3.0 s | 11.2 s |
| `ky-retry-hook-control` | holdout | 50% | 50% | 7,500 | 44,039 | $0.0033 | $0.0253 | 1.7 s | 4.5 s |
| `ky-response-byte-cap` | holdout | 100% | 67% | 5,301 | 16,329 | $0.0019 | $0.0136 | 1.0 s | 3.1 s |
| `ky-header-deletion-extend` | holdout | 100% | 100% | 7,500 | 18,634 | $0.0028 | $0.0195 | 1.3 s | 3.4 s |
| `ky-json-schema-validation` | holdout | 100% | 50% | 7,500 | 12,732 | $0.0019 | $0.0331 | 1.0 s | 11.6 s |
| `jevgrep-secret-files` | holdout | 50% | 100% | 7,500 | 4,735 | $0.0014 | $0.0057 | 1.1 s | 4.1 s |
| `jevgrep-byte-bounded-units` | holdout | 100% | 100% | 7,500 | 6,540 | $0.0015 | $0.0091 | 1.2 s | 3.1 s |
| `jevgrep-credential-redaction` | holdout | 50% | 50% | 7,500 | 920 | $0.0015 | $0.0079 | 1.2 s | 3.0 s |
