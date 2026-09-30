<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/logo-banner-dark.svg">
  <img alt="JevTrace — compiler-guided context for TypeScript/JavaScript" src="assets/logo-banner-light.svg" width="960">
</picture>

<a href="docs/benchmark-vs-jevgrep.md">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/benchmark-vs-jevgrep-dark.svg">
    <img alt="JevTrace vs jevgrep on 19 JS/TS tasks: 98.2% vs 70.6% of required code delivered, 5.9× lower Jev cost, 3.0× faster search, 53% fewer tokens handed to the agent" src="assets/benchmark-vs-jevgrep-light.svg" width="960">
  </picture>
</a>

# JevTrace

<sub>Retrieval benchmark on 19 JS/TS tasks with labels written by the JevTrace authors — see the <a href="docs/benchmark-vs-jevgrep.md">method, per-task results and limitations</a>.</sub>

**[▶ See how it works in 30 seconds](https://123wwwa.github.io/JevTrace/)**

Give it a coding task; it returns the JS/TS code that task needs, within a token budget. It uses the TypeScript compiler to follow calls, types, callers and tests, and uses the Jev decision model (through OpenRouter, TypeSafe, Vercel AI Gateway, OpenCode Zen or your own endpoint) to judge relevance.

## Quick start

```bash
npx -y jevtrace setup                                    # choose a provider and enter its API key, once
claude mcp add jevtrace --scope user -- npx -y jevtrace  # Claude Code: searches whichever project you open
```

Codex and Cursor take one config block each: see [Claude Code, Codex and Cursor](docs/clients.md). To try it without an agent:

```bash
npx -y jevtrace query --root /path/to/your/project --task "Fix refresh token validation"
```

Ask about one behaviour or area of an existing TS/JS codebase ("where is X decided, what else touches it"). Project-wide requests such as "find bugs" or "review everything" get per-area subtasks to call it with instead of code. Supports `.ts/.tsx/.js/.jsx/.mjs/.cjs` and Vue components, ES modules and CommonJS, with or without a tsconfig/jsconfig, up to 20,000 source files; not Svelte/Astro — see [supported projects](docs/usage.md#supported-projects).

## Docs

- [Claude Code, Codex and Cursor](docs/clients.md): setup for each client, and what to do when it does not work
- [Usage](docs/usage.md): CLI options, providers, MCP tools and parameters, benchmarks
- [Architecture](docs/architecture.md): how discovery, compiler expansion and ranking work, and their limits
- [Agent benchmark vs jevgrep and ttsc](docs/agent-benchmark.md), [retrieval benchmark vs jevgrep](docs/benchmark-vs-jevgrep.md), [evaluation](docs/evaluation.md) and [real-task evaluation](docs/discovery-evaluation.md)

Requires Node.js 20+. MIT license.
