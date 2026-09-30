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

A config owns the directory it is in: its included files and the project sources they import, as the compiler loads them (a config that lists only entry points, `"include": ["src/index.ts"]`, still covers the modules behind them). Sources there that it neither includes nor imports (for example `.js` files in a TypeScript project without `allowJs`, or scripts outside `include`) are not searched. Sources under no config at all, such as a front end next to an `e2e/tsconfig.json`, are searched and analysed without one. Directories named `node_modules`, `dist`, `build`, `coverage` and `.next`, and source files over 1 MiB, are skipped.

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

There is no default provider: choose one once with `setup`, which asks for the platform, the API key (hidden while you type), and optionally a model, checks the key with one small request, and saves it:

```bash
node dist/cli.js setup
```

The choice is saved to `~/.jevtrace/config.json`, readable only by you (set `JEVTRACE_CONFIG` to move it, or `off` to ignore it). Running `query` in a terminal with nothing configured starts `setup` first. The environment still works and takes precedence, in this order:

1. `--provider`, `--model`, `--endpoint` on the CLI;
2. `JEVTRACE_PROVIDER`, `JEVTRACE_MODEL`, `JEVTRACE_ENDPOINT` and the provider's key variable (from the shell or `node --env-file=.env`); if only one provider key is set and no provider is named, that provider is used;
3. the saved config. Its key is used only for the provider it was saved with.

With none of these, tools return an error that says to run `setup` (or use `--offline`).

| Provider | `JEVTRACE_PROVIDER` | Credential | Default model | Endpoint |
| --- | --- | --- | --- | --- |
| OpenCode Zen | `opencode` | `OPENCODE_API_KEY` | `jev-1.13` | `https://opencode.ai/zen/v1/systemone` |
| OpenRouter | `openrouter` | `OPENROUTER_API_KEY` | `typesafe/jev-1.13` | `https://openrouter.ai/api/alpha/decisions` |
| TypeSafe | `typesafe` | `TYPESAFE_API_KEY` | `jev-latest` | `https://api.typesafe.ai/v1/systemone` |
| Vercel AI Gateway | `vercel` | `AI_GATEWAY_API_KEY` | `typesafe-ai/jev` | `https://ai-gateway.vercel.sh/typesafe/v1/systemone` |
| Custom | `custom` | optional `JEVTRACE_API_KEY` | `jev-latest` unless overridden | `JEVTRACE_ENDPOINT` |

`JEVTRACE_MODEL` overrides the provider's default model and `JEVTRACE_ENDPOINT` overrides its endpoint. A custom endpoint must implement the TypeSafe/System One `state + questions -> answers` contract. OpenRouter uses its Decisions API, while TypeSafe, Vercel, and custom presets use System One-compatible endpoints; JevTrace normalizes their shared Noul answer shape. This does **not** mean arbitrary chat LLMs are supported yet; alternate generative-model judges need a separate score/calibration policy.

```bash
# OpenRouter
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

Register once for all your projects. Without `--root`, the server searches the project Claude Code is working in (it reads `CLAUDE_PROJECT_DIR`, which Claude Code sets for MCP servers; user-scope servers otherwise start in `~/.claude`). After `setup`, the server reads the saved provider and key, so nothing secret goes into Claude Code's configuration:

```bash
claude mcp add jevtrace --scope user -- node /absolute/JevTrace/dist/cli.js
```

To keep using a `.env` file instead, add `--env-file=/absolute/JevTrace/.env` after `node`.

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

- **Suggested subtasks**: the task restricted to each area of the repository, for example `Find critical bugs in this project — only in src/router/ (LinearRouter, Route, PatternRouter)`. Areas come from splitting the largest directory first (up to 16 areas), so a large `src/` is split before small top-level folders are. When every source sits directly in one directory (a flat `src/`), the files are split into runs in name order instead, one file each when they fit, for example `… — only in src/rename.ts (rename)`. Each line passes the scope check on its own and can be passed back as the task, one call per area.
- **A repository map**: each directory with its source-file count and top-level declarations, merged into parent directories to fit `maxChars`.

The server instructions also tell agents that split a larger request to call JevTrace once per subtask, including from subagents. Pass `scopeCheck: false` to retrieve for the exact wording anyway. The check costs one small Jev request, which is counted in the usage log.

The map ends with the directories JevTrace does not analyse (see below), so an agent reviews those with Grep and Read instead of calling JevTrace for them.

### Code JevTrace does not analyse

Sources inside a config's directory that it neither includes nor imports (a browser playground in `web/`, `.test.mjs` files, build scripts) are not indexed, but they are listed by path, per directory. Git-ignored paths are left out, so build copies and generated fixtures are not listed; so are files directly in the repository root, which are mostly tool configs (`vite.config.ts`). Without git every other path is listed.

Discovery's first stage shows those directories to Jev next to the analysed ones, in the same request. Then:

- **An unanalysed directory wins clearly** (by 0.2 or more over the best analysed directory): the result is `status: "not-covered"` with the directories and their files, and nothing else is judged. It comes back after that one stage (about 0.7 s on FlowName instead of 1.3–1.6 s) and tells the agent to search those files directly instead of calling JevTrace again for the task.
- **Otherwise** retrieval continues as usual, and a note names any unanalysed directory Jev also found relevant (`Also relevant, not analysed by JevTrace …`), for example the `test/` directory next to the code under change.

In a repository whose analysed code is one directory, this adds the directory request that is otherwise skipped whenever unanalysed directories exist.

Explicit file/line retrieval keeps the `maxDepth`, `maxNodes`, threshold, reverse, wrapper-lookahead, and visit-policy controls.

### Token savings

Nothing is shown in the chat on its own. Every task-only result ends with a short `Session so far:` line for the agent, and the same totals are in the structured result as `contextSavings.session`. To see the savings when you want to:

- **Ask the agent**, for example "How many tokens has JevTrace saved?". It calls the `usage_stats` tool, which returns the usage-log summary for the last 30 days (or `days`) plus the totals since this server started. The tool is described to agents as for that question only, so it is not called during coding tasks.
- **Run `stats`** in a terminal (see [Usage log and `stats`](#usage-log-and-stats)).

The reduction number is scoped to `final ranking pool -> returned context`. Token counts use a source-size estimator (about characters divided by four); they are **not provider billing tokens and not a claim about end-to-end agent cost**. Latency history and session totals are in-memory only and reset when the server restarts; the usage log keeps every call.

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
