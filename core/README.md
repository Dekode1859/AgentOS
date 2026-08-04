# AgentOS Core

The generic runtime. Contains **no domain knowledge** — no jobs, learning,
curriculum, resumes, games, or app workflows. If a name describes *what* the
system does, it does not belong here; Core only defines *how* execution happens.

## Public API

```python
from agentos import run, AppConfig, WorkspaceFolder
```

- `AppConfig` / `WorkspaceFolder` — the contract an app fills in.
- `run(config)` — boots the desktop shell + OpenCode runtime for that app.

## Modules

| Module | Responsibility |
|--------|----------------|
| `config.py` | The Core↔App contract (`AppConfig`). |
| `runtime/shell.py` | PyWebView window + UI HTTP server + `run()`. |
| `runtime/server.py` | OpenCode `serve` subprocess lifecycle. |
| `runtime/paths.py` | Dev/bundle path resolution (app_id injected). |
| `storage/` | Generic read/write/list/delete; no folder semantics. |
| `providers/` | LLM provider list, auth, model switching. |
| `agents/` | Reads app-declared agents from `opencode.json` (executes none). |
| `tools/` | Documents delegation to OpenCode's tool runtime (code-free). |
| `events/` | Documents the OpenCode SSE → UI event bus (code-free here). |
| `bridge.py` | JS↔Python UI API; relays app config, runs generic ops. |
| `ui/` | Shared chat UI; branding/folders/agents injected via config. |

## Consuming Core

Two supported modes; both yield the same `import agentos`.

**Shared source (monorepo).** Apps under `apps/` add `core/` to `sys.path` and
import. This is how the in-repo apps consume Core.

**Installed package.** Core builds as a wheel (`uv build`) named `agentos`, with
`ui/` shipped as package data. Apps in their own repos depend on it:

```toml
[project]
dependencies = ["agentos"]

[tool.uv.sources]
agentos = { path = "../AgentOS/core", editable = true }
```

Swapping this Core for another that implements the same public API requires no
change to any app, in either mode.

Playwright is an optional extra (`agentos[browser]`) — Core never imports it at
import time; it appears only inside the browser-agent subprocess payload.

`requires-python` is capped below 3.13 because `runtime/shell.py` uses the
stdlib `cgi` module, which 3.13 removed.

## Engine

Core hosts **OpenCode** as the execution engine (agents, tools, sessions,
events). Core manages its process lifecycle and wraps it with the desktop
shell, storage, providers, and UI. It does not reimplement that engine.
