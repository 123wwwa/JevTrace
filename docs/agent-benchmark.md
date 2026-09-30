# Agent benchmark (pilot): baseline vs JevTrace vs jevgrep vs ttsc

Does a coding agent spend less when a code-context tool is available? The same agent gets the same question in every arm, and everything the session does is measured.

**Status: pilot.** 5 focused tasks, one session per task and arm, one model. Treat the numbers as a direction, not a result; see [Limitations](#limitations).

## Results: each tool as its instructions tell the agent to use it (medians over 5 tasks)

| Arm | Agent tokens | Repository searches | Tool calls | Files read | API cost | Jev cost | Wall time | Labelled code in final answer | Labelled code in tool's first answer |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Baseline (Read, Grep, Glob) | 120k | 6 | 0 | 2 | $0.111 | – | 27 s | 13/15 | – |
| **+ JevTrace** | **50k** | **0** | 1 | **0** | **$0.085** | $0.004 | **19 s** | **15/15** | **15/15** (7.2k tokens) |
| + jevgrep | 166k | 4 | 1 | 2 | $0.111 | $0.026 | 30 s | 13/15 | 13/15 (14.8k tokens) |
| + ttsc | 116k | 3 | 2 | 2 | $0.104 | – | 29 s | 14/15 | 8/15 (0.7k tokens) |

These are the guided arms: each tool with one system-prompt line saying to call it first, the same sentence for all three (for jevgrep, on top of its own skill). Repository searches are Read, Grep and Glob inside the repository plus shell searches (`grep`, `find`) in the jevgrep arm, the only one with Bash. The last column scores the tool's first answer alone, before the agent did anything else: JevTrace and jevgrep return code, ttsc returns compiler-resolved names, locations and edges without source, so it names fewer declarations in fewer tokens and leaves the reading to the agent.

Without the instruction line (medians):

| Arm | Agent tokens | Repository searches | Sessions that never called the tool | API cost | Labelled code in final answer |
| --- | ---: | ---: | ---: | ---: | ---: |
| + JevTrace | 120k | 4 | 2 of 5 | $0.103 | 13/15 |
| + jevgrep (with its skill) | 150k | 4 | 3 of 5 | $0.089 | 12/15 |
| + ttsc | 206k | 6 | 0 of 5 | $0.143 | 14/15 |

Per-task rows, means and every session's stream are in `benchmarks/results/agent/` (`report.json`).

What the pilot shows:

- **JevTrace answered 4 of 5 tasks with one call and no repository search** (40k–72k tokens against the baseline's 89k–263k), and its first answer already named every labelled declaration.
- **jevgrep's first answer also carried most of the needed code (13/15), but at twice JevTrace's size**, because it prints source without a budget by default (15k–20k tokens per search on Hono and Ky, 78 KB on ky; 4k on the small jevgrep core). Claude Code saves an output that large to a file, and the agent read the file back and then searched further, so sessions ran longer than the baseline. Its own Jev cost was about seven times JevTrace's.
- **ttsc returned the smallest answers** (under 1k tokens) and named about half the labelled declarations up front; the agent then read the files it pointed to. Guided, that stayed below the baseline in calls but not in tokens at the median.
- **Tokens fell further than cost.** Most of the tokens a session saves are cache reads of the growing conversation, the cheapest tokens; the system prompt and each new tool output are cache writes, and those stay. For JevTrace, median cost fell 23% while median tokens fell 59%.
- **Available is not used.** Without the line, the agent skipped JevTrace in 2 of 5 sessions and jevgrep in 3 of 5, even with jevgrep's skill (which itself says to prefer grep for exact strings); on ky-retry-after the task quotes the header name, so Grep finds it.

### The outlier, and the fix it led to

In the first guided run, hono-request-body-reuse was the most expensive JevTrace session (416k tokens, 10 Grep/Read calls): after JevTrace's answer the agent reread `src/request.ts` and searched the tests. JevTrace's answer was the cause. Jev had scored the right code highly (`#cachedBody` 0.93, `text()` 0.91, `json()` 0.84), but lead diversity skipped `text()` and `json()` because their dependencies overlap `#cachedBody`'s, and filled the slots with two Lambda-adapter `createRequest`s (0.70) that merely did not overlap; their callers, tests and siblings made up about 20 of the 34 symbols returned. The field `#cachedBody` works on (`bodyCache`) was missing, and it was the agent's first search.

Two changes followed: a lead scored more than 0.1 above a diverse one now takes the slot first, and a method's instance fields (`this.bodyCache`, `const { bodyCache } = this`) are followed as dependencies. The answer became four `src/request.ts` leads with the class fields, its outline and the matching tests, in 2.9k instead of 3.6k tokens; the retrieval benchmark stayed at 98.2%. Rerun, the guided session took 40k tokens, no Grep/Read, 19 s and $0.073. The tables use the rerun for the two JevTrace arms of this task; the other four tasks' JevTrace sessions ran on the build before the fix.

## Method

- **Agent:** Claude Code 2.1.282 headless (`claude -p`), model `sonnet` (claude-sonnet-5), with user settings, hooks, plugins and other MCP servers switched off (`--setting-sources ""`, `--strict-mcp-config`). Built-in tools limited to Read, Grep and Glob in every arm; the jevgrep arms also have Bash, restricted to `jg` and the skill's `command -v jg` check (Claude Code still runs read-only commands such as `grep` without approval, and those are counted as repository searches).
- **Prompt, identical in every arm:** the task, then "Find the code in this repository that must be read or changed to do this task. Do not modify any files. End your answer with a section "Relevant declarations" listing each one on its own line as `path/to/file — symbolName`."
- **Guided arms** add one system-prompt line of the kind a user puts in CLAUDE.md: "This repository has the <tool>. To find the code a task needs, call <tool> (for jevgrep: run `jg "<the task>" .`) before using Grep, Glob or Read, then read only what its result did not cover."
- **Tasks:** ky-retry-after, hono-token-clock-skew, hono-request-body-reuse, hono-thrown-http-response and jevgrep-cache-validation from the [retrieval benchmark](benchmark-vs-jevgrep.md), at its pinned commits. All are focused tasks (one behaviour), the kind JevTrace is built for; broad onboarding questions were not tested.
- **Metrics,** from Claude Code's stream-json output: agent tokens = input + cache writes + cache reads + output over the session; tool calls by name (for jevgrep, `jg` searches, not `--version`, `doctor` or `files`); distinct repository files passed to Read (a tool output Claude Code saved to a file and the agent read back is not a repository file); API cost as Claude Code reports it; each tool's provider-reported Jev cost; wall time. "Labelled code" counts the task's labelled declarations whose name and file appear in the text: the final answer, or the tool's first answer (the saved file's full content when the output was saved).
- **JevTrace:** this repository's build, through OpenRouter.
- **jevgrep:** 0.7.0 through OpenRouter, with the skill bundled in that release as the agent's instructions, since jevgrep's README makes the skill part of the setup. jevgrep does not support Windows, so `jg` is a shim (`benchmarks/competitor/agent-shim/jg`) that runs the pinned image in Docker, copying the checkout into the container without `node_modules` and `.git`; container start adds a few seconds per search to its wall time. One first search (jevgrep-cache-validation) failed with "Command failed" after a successful provider request and succeeded when the agent retried.
- **ttsc:** `ttsc` and `@ttsc/graph` 0.30.4 with `typescript` 7.0.2, installed outside the repositories and started with `--cwd` and, where needed, `--tsconfig`: Hono's root `tsconfig.json` only lists project references, so its graph was empty until pointed at `tsconfig.build.json`; the jevgrep package extends a workspace config that is not installed, so ttsc got a standalone config over the same sources. JevTrace read all three repositories as they are.

Reproduce:

```bash
npm run build
node scripts/agent-benchmark.mjs --ttsc-dir /path/with/ttsc-installed --arms baseline,jevtrace,jevtrace-guided,jevgrep,jevgrep-guided,ttsc,ttsc-guided
node scripts/agent-benchmark.mjs --rescore --arms baseline,jevtrace,jevtrace-guided,jevgrep,jevgrep-guided,ttsc,ttsc-guided
```

The jevgrep arms need Docker with the image from `benchmarks/competitor/Dockerfile` and `OPENROUTER_API_KEY`..

## Limitations

- **Small and single-run.** 5 tasks, 1 session per arm (the outlier task's JevTrace arms were rerun once after the fix); one session can move a mean by 60k tokens, hence medians. Unguided adoption in particular varies between sessions of the same task.
- **Chosen for JevTrace.** Focused tasks in small repositories (Ky, Hono, jevgrep core), with labels written by the JevTrace authors. Broad onboarding questions, where ttsc reports its largest gains, were not tested. jevgrep's own benchmark measures task success on Python tasks, which this does not.
- **Guidance differs from the tools' own methods.** ttsc's benchmark gives no instruction and instead discards and retries tool-arm sessions that never called the tool; jevgrep relies on its skill. Here unguided sessions are kept, and guided arms measure the effect when the tool is used.
- **Setups differ from the tools' usual ones:** ttsc installed apart from the project with an explicit or substitute tsconfig for two repositories; jevgrep through Docker on Windows; all on one Windows machine.
- **Correctness is a name check,** not a judgement of the answer's explanation.
