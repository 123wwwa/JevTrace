# Using JevTrace with Claude Code, Codex and Cursor

JevTrace is an MCP server that runs on your machine over stdio. Every client below starts it with `npx`, so there is nothing to clone or build. You need Node.js 20 or newer.

## 1. Choose a provider (once)

JevTrace uses the Jev decision model to judge which code matters. Pick a provider and enter its API key once; the choice is saved to `~/.jevtrace/config.json` and every client below uses it:

```bash
npx -y jevtrace setup
```

It lists the providers (OpenCode Zen, OpenRouter, TypeSafe, Vercel AI Gateway, or your own endpoint), hides the key as you type, and checks it with one small request. Environment variables still take precedence; see [Jev provider and model](usage.md#jev-provider-and-model).

## 2. Register the MCP server

JevTrace needs to know which project to search. Each client tells it differently, so the setups below differ in that one detail.

### Claude Code

```bash
claude mcp add jevtrace --scope user -- npx -y jevtrace
```

Claude Code passes the project you have open as `CLAUDE_PROJECT_DIR`, so one user-scope registration works in every project. Check it with `claude mcp list`, or `/mcp` inside a session.

On Windows, run `npx` through `cmd`:

```bash
claude mcp add jevtrace --scope user -- cmd /c npx -y jevtrace
```

### Cursor

Add JevTrace to `~/.cursor/mcp.json` (every project) or `.cursor/mcp.json` (one project). `${workspaceFolder}` is the project you have open:

```json
{
  "mcpServers": {
    "jevtrace": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "jevtrace", "--root", "${workspaceFolder}"]
    }
  }
}
```

On Windows, use `"command": "cmd"` and put `"/c", "npx"` first in `args`. The server then appears under Cursor Settings → MCP.

### Codex

```bash
codex mcp add jevtrace -- npx -y jevtrace
```

or in `~/.codex/config.toml`:

```toml
[mcp_servers.jevtrace]
command = "npx"
args = ["-y", "jevtrace"]
# The first npx run downloads the package; allow it more than the 10 s default.
startup_timeout_sec = 60
tool_timeout_sec = 120
```

Codex starts MCP servers without telling them which project is open, so JevTrace searches its working directory: start Codex from the project root. To pin a project instead, add it in that project's `.codex/config.toml` (trusted projects only) with `cwd = "/absolute/path/to/project"`, or pass `"--root", "/absolute/path/to/project"` in `args`. On Windows, use `command = "cmd"` and `args = ["/c", "npx", "-y", "jevtrace"]`.

## 3. Use it

Ask for a change or a question about one behaviour, the way you would ask a colleague:

- "Change how HTTP 429 retry delay is calculated from Retry-After"
- "Where is the session cookie refreshed, and what else touches it?"
- "Why does the upload endpoint reject files over 1 MB?"

The agent calls `retrieve_dependency_context` with the task and gets the implementing code plus its callers, callees, types and tests in one answer, instead of a series of Grep and Read calls. JevTrace's server instructions ask agents to call it before searching. If yours still greps first, add this line to `CLAUDE.md`, `AGENTS.md` or Cursor rules:

```
To find the code a task needs, call mcp__jevtrace__retrieve_dependency_context with the task before using Grep, Glob or Read, then read only what its result did not cover.
```

Project-wide requests ("find bugs", "review everything") return per-area subtasks to call it with instead of code. See [supported projects](usage.md#supported-projects) for what it analyses.

## Checking what it did

```bash
npx -y jevtrace stats --days 7
```

summarizes the calls on your machine (task, outcome, tokens returned, Jev requests and cost) from `~/.jevtrace/usage.jsonl`, and, for Claude Code, how many sessions used JevTrace and how many searched only with Grep, Glob or Read. Nothing in that log leaves your machine; set `JEVTRACE_USAGE_LOG=off` to turn it off.

## If it does not work

| Symptom | Cause and fix |
| --- | --- |
| The tool answers "No decision provider is configured" | Run `npx -y jevtrace setup` in a terminal. |
| It searches the wrong project | Claude Code: nothing to do; Cursor: check `--root ${workspaceFolder}`; Codex: start Codex in the project, or set `cwd` / `--root`. |
| The server times out on first start | The first `npx` run downloads the package. Raise the client's startup timeout (Codex: `startup_timeout_sec`), or install it once with `npm install -g jevtrace` and use `jevtrace` as the command. |
| `spawn npx ENOENT` on Windows | Use `cmd /c npx` as shown above. |
