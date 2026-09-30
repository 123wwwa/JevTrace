# Usage

Requires Node.js 20 or newer. The package is not published to npm yet, so run it from a checkout:

```bash
npm install
npm run build
npm test
```

## Supported projects

JevTrace analyses JavaScript and TypeScript through the TypeScript compiler, so it supports what the compiler reads and nothing else:

| | Supported | Not supported |
| --- | --- | --- |
| Files | `.ts`, `.tsx`, `.mts`, `.cts`, `.js`, `.jsx`, `.mjs`, `.cjs`; `.vue` single-file components (`<script>` and `<script setup>`, JS or TS) | Vue template expressions (a method called only from the template shows no caller); `.svelte`, `.astro`, scripts inside HTML; `.d.ts` files are not entry points |
| Modules | ES modules, CommonJS (`require`, `module.exports`, `exports.x`), TypeScript path aliases, including `.vue` imports through them | Dynamic `import()` / `require` with computed paths |
| Project config | `tsconfig*.json` and `jsconfig*.json`, several per repository (monorepos: each file uses the most specific project that includes it); a base config that is not installed (`"extends": "@org/tsconfig"` before `npm install`) is skipped with a note | Build-tool-only aliases (webpack/Vite `resolve.alias`) that are not mirrored in `paths` |
| No config | Every source file, analysed with `allowJs`; above 5,000 files the compiler loads the files around the entry (its highest ancestor directory holding at most 5,000), and imports outside it are still followed | Callers outside that directory in such a repository |
| Size | Discovery indexes up to 20,000 source files (`maxFiles`, up to 100,000); about 5.5 s the first time and 0.6 s after for 5,400 files | Beyond `maxFiles`, later paths in name order are not searched, and the result says so |
| Tasks | One behaviour, feature or area ("where is X decided", "change how Y works"), in any language | Project-wide requests (review everything, find bugs anywhere, scaffold a project): these get suggested per-area subtasks and a repository map instead of code |

A config owns the directory it is in: sources there that it does not include (for example `.js` files in a TypeScript project without `allowJs`, or scripts outside `include`) are not searched. Sources under no config at all, such as a front end next to an `e2e/tsconfig.json`, are searched and analysed without one. Directories named `node_modules`, `dist`, `build`, `coverage` and `.next`, and source files over 1 MiB, are skipped.

## CLI

```bash
node dist/cli.js query --root /absolute/project --task "Fix refresh token validation"
node dist/cli.js discover --root /absolute/project --task "Fix refresh token validation"
node dist/cli.js query --root /absolute/project --task "Fix refresh token validation" --file src/auth.ts --line 42
node dist/cli.js query --root /absolute/project --task "Fix refresh token validation" --evidence evidence.json
node dist/cli.js query --root /absolute/project --task "Fix refresh token validation" --evidence evidence.json --visit-policy choice
node dist/cli.js query --root /absolute/project --task "Fix refresh token validation" --file src/auth.ts --line 42 --provider typesafe --model jev-1.13
```

The CLI emits structured JSON. Once the package is published, `jevtrace` replaces `node dist/cli.js`.

- `query` with only `--task` runs the task-only pipeline: discovery, compiler expansion, and budgeted context selection (see [architecture](architecture.md)).
- `discover` runs discovery only and returns leads without expanding context.
- `--file`/`--line`, `--file`/`--symbol`, or `--evidence` start from a known entry and use the explicit-entry retriever instead of discovery.
- `--no-scope-check` retrieves even when the task reads as project-wide (see [Broad tasks](#broad-tasks)).
- `--offline` needs no provider. For task-only queries it uses the lexical branch as leads, compiler shallow expansion, and structural budget cutting. Explicit file/line queries keep the include-all compiler baseline.

### From jevgrep leads

Existing [jevgrep](https://github.com/dzhng/jevgrep) leads remain supported:

```bash
jg "Where is refresh token validation implemented?" .
# Suppose jg reports a reading lead in src/auth.ts around line 42.
node dist/cli.js query --root . --task "Fix refresh token validation" --file src/auth.ts --line 42
```

The `--evidence` option is JevTrace's own structured lead format for integrations that already have machine-readable `{ path, leads[] }` data. It is not jevgrep's stdout format.

## Jev provider and model

JevTrace defaults to OpenRouter, but provider and model selection are independent configuration. CLI queries accept `--provider` and `--model`. MCP hosts configure the same values through environment variables.

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
OPENROUTER_API_KEY=... node dist/cli.js query ...

# TypeSafe direct
TYPESAFE_API_KEY=... node dist/cli.js query ... --provider typesafe --model jev-1.13

# Vercel AI Gateway
AI_GATEWAY_API_KEY=... node dist/cli.js query ... --provider vercel

# OpenCode Zen (use --model jev-1.13-free for the free variant when available)
OPENCODE_API_KEY=... node dist/cli.js query ... --provider opencode
```

Other decision APIs can be added as providers without touching retrieval; see [Adding a decision provider](architecture.md#adding-a-decision-provider).

Other settings: `JEVTRACE_JEV_BATCH_SIZE` sets the local provider batch cap (default 16). Legacy `JEVTRACE_JUDGE=openrouter-jev|jev|include-all` is still accepted.

## MCP server

Running the CLI without `query` or `discover` starts a stdio MCP server for the given root:

```json
{
  "mcpServers": {
    "jevtrace": {
      "command": "node",
      "args": ["/absolute/JevTrace/dist/cli.js", "--root", "/absolute/project"],
      "env": { "OPENROUTER_API_KEY": "your-key" }
    }
  }
}
```

This repository's `.vscode/mcp.json` runs the server against the checkout itself, reading credentials from `.env`.

### Claude Code

Register once for all your projects. Without `--root`, the server searches the project Claude Code is working in (it reads `CLAUDE_PROJECT_DIR`, which Claude Code sets for MCP servers; user-scope servers otherwise start in `~/.claude`). `--env-file` lets Node read the key from a `.env` file instead of storing it in Claude Code's configuration:

```bash
claude mcp add jevtrace --scope user -- node --env-file=/absolute/JevTrace/.env /absolute/JevTrace/dist/cli.js
```

Check the connection with `claude mcp list` or `/mcp` inside Claude Code, then ask for context, for example "Use jevtrace to find the code that decides retry delays". Pass `--root /absolute/project` after `cli.js` to pin one repository instead.

### Usage log and `stats`

Every MCP tool call is appended to `~/.jevtrace/usage.jsonl`: time, tool, project, task, outcome, time taken, tokens sent and excluded, and Jev requests, input tokens and cost. It stays on your machine. Set `JEVTRACE_USAGE_LOG=off` to disable it or to a path to move it.

```bash
node /absolute/JevTrace/dist/cli.js stats --days 7
```

To see what the agent itself receives for a task (Claude Code shows the model the structured result, which carries the same bounded context as the text), run:

```bash
node --env-file=.env scripts/agent-view.mjs /absolute/project "Describe the change you want"
```

`stats` summarizes those calls and also scans Claude Code's session transcripts (`~/.claude/projects`, or `CLAUDE_CONFIG_DIR`) to show how many sessions called JevTrace and how many searched only with Grep, Glob or Read, which is how you can tell when the agent did not use it.

### Tools

`retrieve_dependency_context` is the primary **task-only** tool. It accepts a natural-language coding task and always runs repository discovery before compiler expansion and final budget selection. It intentionally does not accept `file` or `line`, so an agent cannot silently bypass discovery by inventing an entry location.

`retrieve_from_entry` is the explicit-entry compatibility tool. Use it only when the caller already has a trusted `file` + `line`, `file` + `symbol`, or structured `evidence: { path, leads[] }` from the user or another tool.

`discover_entries` exposes discovery without compiler expansion or final context selection. It returns `lexicalCandidates` from the local RRF retriever, `directoryLeads` from Jev directory-scope selection, `fileLeads` from files inside the selected scopes, and diversity-selected `semanticLeads` from symbols inside those files.

### Parameters

Discovery and task-only retrieval accept `maxCandidates` (default 64), `maxLeads` (default 4), `maxFiles` (default 3000), `maxRelevantDirectories` (default 8), `maxJevFiles` (default 256 after directory selection), and `maxRelevantFiles` (default 8). Lexical hints are visible to Jev but never restrict the semantic search space. Semantic thresholds remain provisional.

For task-only retrieval, `tokenBudget` (default 8000 estimated tokens) is the final context budget. `perLeadNodeLimit` (default 24), `perLeadTokenBudget` (defaults to the final budget), `reverseFanIn` (default 12), and `neighborhoodTokenBudget` (default twice the final budget) bound compiler expansion before remote context ranking. Lexical candidates guide discovery but are not merged into the final pool unless enabled (`--lexical-final-merge` in the CLI, `includeLexicalParallel=true` over MCP). `contextRanking=jev` calls Stage 4 only when the final pool exceeds `tokenBudget`; `contextRanking=structural` disables Stage 4.

### Broad tasks

Before returning code, `retrieve_dependency_context` asks Jev whether the task names one behaviour or area (in parallel with discovery, so specific tasks are not slowed down). When it does not ("find critical bugs", "review the whole project", "이 프로젝트의 기본적인 틀을 짜줘"), the result has `status: "broad"`, the `specificity` score, and instead of code:

- **Suggested subtasks**: the task restricted to each area of the repository, for example `Find critical bugs in this project — only in src/router/ (LinearRouter, Route, PatternRouter)`. Areas come from splitting the largest directory first (up to 16 areas), so a large `src/` is split before small top-level folders are. Each line passes the scope check on its own and can be passed back as the task, one call per area.
- **A repository map**: each directory with its source-file count and top-level declarations, merged into parent directories to fit `maxChars`.

The server instructions also tell agents that split a larger request to call JevTrace once per subtask, including from subagents. Pass `scopeCheck: false` to retrieve for the exact wording anyway. The check costs one small Jev request, which is counted in the usage log.

Explicit file/line retrieval keeps the `maxDepth`, `maxNodes`, threshold, reverse, wrapper-lookahead, and visit-policy controls.

### Context savings UI (MCP Apps)

`retrieve_dependency_context` also publishes a versioned MCP Apps view (currently `ui://jevtrace/context-savings-v2.html`) so hosts do not reuse stale dashboard bundles after UI changes. The legacy `ui://jevtrace/context-savings.html` URI remains registered as an alias to the latest bundle so existing chat results do not break. Hosts that support MCP Apps render the result as an inline dashboard; other hosts receive the same text and structured content.

The dashboard shows one thing: **how many tokens JevTrace has saved in this session**.

- A headline number: estimated tokens saved across every task-only retrieval since the server started, with the overall reduction and retrieval count.
- A cumulative chart: tokens that would have been sent without JevTrace (every compiler candidate, dashed gray) against tokens actually sent to the agent (blue); the shaded gap is the saving. Hover or use the arrow keys to read the totals after any retrieval. After a single retrieval it is shown as two bars.
- A **Details** popover with the latest retrieval only (candidate pool, sent tokens, symbols, provider requests, context ranking, time, status).

The same totals are in the structured result as `contextSavings.session` (with cumulative `points`, thinned to at most 500) and in the text result as a `Session so far:` line.

The reduction number is scoped to `final ranking pool -> returned context`. Token counts use a source-size estimator (about characters divided by four); they are **not provider billing tokens and not a claim about end-to-end agent cost**. Latency history and session totals are in-memory only and reset when the server restarts. The dashboard is attached to the task-only tool only. It follows the host's light/dark theme from the MCP Apps host context, shows the host-supplied error message when a call fails, and shows a "no relevant code" notice (with the session totals) when discovery finds nothing.

To see the dashboard without an MCP Apps host, record real results from the stdio server and open the bundled test host, which renders them the way a host does (sandboxed iframe plus the ext-apps `AppBridge`):

```bash
npm run ui:preview            # add -- --online to use the provider in .env, -- --root <dir> for another project
npm run ui:host               # then open http://localhost:5179
```

## Benchmarks

```bash
npm run bench                 # synthetic suite with current defaults
npm run bench:rounds          # per-frontier candidate/payload/latency trace
npm run bench:thresholds      # body-threshold sweep
npm run bench:stability       # cold-score stability
npm run bench:batch-sizes     # provider batching diagnostic
npm run bench:real-suite -- --offline --output benchmarks/results/real-offline-results.json
npm run bench:real-suite -- --provider openrouter --repeats 3 --output benchmarks/results/real-ablation-results.json
npm run bench:real-suite -- --manifest benchmarks/holdout-cases.json --split holdout --modes pipeline-no-lexical-final-merge
npm run bench:stage4-sweep -- --provider openrouter --repeats 3 --budgets 2000,4000,6000,8000 --output benchmarks/results/stage4-sweep.json
```

The real-task suite expects pinned checkouts of the benchmark repositories next to this one; see [discovery-evaluation.md](discovery-evaluation.md).
