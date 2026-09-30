# Benchmark: JevTrace vs jevgrep

A head-to-head **retrieval** benchmark on JavaScript/TypeScript tasks: both tools get the same natural-language task and the same repository checkout, and both are scored on the text a coding agent would actually receive.

| Metric (mean over 19 tasks) | JevTrace | jevgrep 0.7.0 |
| --- | ---: | ---: |
| Required code delivered (required-level recall) | **98.2%** | 70.6% |
| Tasks with all required code delivered | **18 / 19** | 7 / 19 |
| Tokens handed to the agent | **5,557** | 11,832 |
| Jev requests | **14.3** | 58.2 |
| Jev input tokens | **89k** | 529k |
| Jev cost per search | **$0.0037** | $0.0222 |
| Search time | **2.0 s** | 5.9 s |

Per task, JevTrace delivered more of the required code on 12 tasks, jevgrep on 1, and 6 were tied.

## Method

- **Tasks.** 19 source-reviewed tasks from `benchmarks/real-cases.json` (4 development) and `benchmarks/holdout-cases.json` (15 holdout) across three repositories: [Ky](https://github.com/sindresorhus/ky), [Hono](https://github.com/honojs/hono) (448 source files) and jevgrep's own core sources, each pinned to a commit. Each task lists the minimum declarations needed to investigate or change the behaviour, and whether the body or only the signature is required.
- **Tools.** JevTrace at its MCP defaults (task-only, output capped at 30,000 characters, which leaves a 6,250-token code budget). jevgrep `@dzhng/jevgrep@0.7.0` at its defaults (`jg --no-cache "<task>" <root>`, unlimited source), run in a Linux container because jevgrep does not support Windows. A second jevgrep configuration capped at `--max-source-bytes 32000` (about the same 8,000 tokens) reached 73.2% recall.
- **Provider.** Both tools used Jev through OpenRouter. Jev cost and input tokens come from the provider-reported `usage` of every response (Jev is billed at $0.042 per million input tokens; output is free).
- **Scoring.** One rule for both tools, applied to the delivered text: a body-level target counts when its first line and at least 90% of its lines appear in the output; a signature-level target counts when its first line appears. Tokens are characters ÷ 4 for both.
- **Timing.** Wall-clock time of one cold search. jevgrep's repositories were copied onto the container's own filesystem first; reading them through a Windows bind mount made jevgrep about three times slower (17.4 s) and was not used.

## Limitations

- **The labels were written by the JevTrace authors.** They are declaration-level, which suits a tool that expands declarations through the compiler. Most of jevgrep's misses are supporting types and error classes that it lists as reading leads without source; an agent can open those files itself, and this benchmark does not credit that.
- **Small and JS/TS-only.** 19 tasks in three repositories, one cold run each (jevgrep was run twice with the same recall). The 4 development tasks shaped JevTrace's design, and the holdout informed later changes (see [discovery-evaluation.md](discovery-evaluation.md)), including fixes found by using JevTrace on Hono through Claude Code. jevgrep also supports Python, Go and Rust; JevTrace does not.
- **Retrieval, not task success.** jevgrep's own published result measures end-to-end coding-agent success and cost on Python SWE-bench tasks. This benchmark does not measure whether an agent completes the task.
- **Where JevTrace lost:** `hono-cookie-prefix-rules`, where it missed the `_serialize` helper. Across repeated runs the single miss moves between tasks, so treat one-task differences as noise.

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
| `ky-retry-after` | development | 100% | 75% | 7,000 | 23,716 | $0.0021 | $0.0136 | 1.3 s | 3.7 s |
| `ky-timeout-cleanup` | development | 100% | 50% | 7,080 | 13,351 | $0.0025 | $0.0309 | 1.2 s | 11.8 s |
| `jevgrep-cache-validation` | development | 100% | 33% | 5,303 | 4,122 | $0.0010 | $0.0029 | 1.1 s | 1.5 s |
| `jevgrep-selection-evidence` | development | 100% | 67% | 6,758 | 4,917 | $0.0015 | $0.0080 | 1.1 s | 3.1 s |
| `hono-etag-validator-list` | holdout | 100% | 100% | 4,246 | 4,956 | $0.0042 | $0.0232 | 2.5 s | 5.1 s |
| `hono-ip-mapped-ranges` | holdout | 100% | 100% | 6,334 | 5,504 | $0.0067 | $0.0271 | 3.0 s | 6.3 s |
| `hono-token-clock-skew` | holdout | 100% | 33% | 7,070 | 4,925 | $0.0064 | $0.0277 | 3.0 s | 6.6 s |
| `hono-request-body-reuse` | holdout | 100% | 67% | 4,162 | 17,098 | $0.0061 | $0.0289 | 3.2 s | 7.7 s |
| `hono-cookie-prefix-rules` | holdout | 67% | 100% | 3,878 | 14,948 | $0.0082 | $0.0354 | 3.5 s | 8.6 s |
| `hono-deadline-dynamic` | holdout | 100% | 50% | 4,403 | 1,268 | $0.0041 | $0.0218 | 3.3 s | 5.7 s |
| `hono-csp-nonce` | holdout | 100% | 100% | 4,811 | 8,053 | $0.0079 | $0.0356 | 3.7 s | 8.6 s |
| `hono-thrown-http-response` | holdout | 100% | 50% | 5,048 | 18,029 | $0.0059 | $0.0529 | 3.1 s | 11.2 s |
| `ky-retry-hook-control` | holdout | 100% | 50% | 7,160 | 44,039 | $0.0032 | $0.0253 | 1.4 s | 4.5 s |
| `ky-response-byte-cap` | holdout | 100% | 67% | 4,837 | 16,329 | $0.0019 | $0.0136 | 0.9 s | 3.1 s |
| `ky-header-deletion-extend` | holdout | 100% | 100% | 7,058 | 18,634 | $0.0026 | $0.0195 | 1.3 s | 3.4 s |
| `ky-json-schema-validation` | holdout | 100% | 50% | 4,680 | 12,732 | $0.0019 | $0.0331 | 1.0 s | 11.6 s |
| `jevgrep-secret-files` | holdout | 100% | 100% | 2,794 | 4,735 | $0.0015 | $0.0057 | 1.0 s | 4.1 s |
| `jevgrep-byte-bounded-units` | holdout | 100% | 100% | 6,095 | 6,540 | $0.0013 | $0.0091 | 1.1 s | 3.1 s |
| `jevgrep-credential-redaction` | holdout | 100% | 50% | 6,861 | 920 | $0.0018 | $0.0079 | 1.1 s | 3.0 s |
