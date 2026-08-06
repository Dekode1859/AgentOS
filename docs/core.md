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

**Shared source (monorepo).** The example apps under `apps/` add the repo root
to `sys.path` and import. This is how the frozen in-repo apps consume Core.

**Installed package.** Core builds as a wheel (`uv build`) named `agentos`, with
`ui/` shipped as package data. Apps in their own repos depend on it:

```toml
[project]
dependencies = ["agentos-desktop"]

[tool.uv.sources]
agentos-desktop = { path = "../AgentOS", editable = true }
```

or straight from git:
`agentos-desktop @ git+https://github.com/Dekode1859/AgentOS@v0.3.0`

The distribution is `agentos-desktop`; the import stays `agentos`. The bare name
belongs to an unrelated project on PyPI, so depending on it silently installs
the wrong package instead of failing.

Swapping this Core for another that implements the same public API requires no
change to any app, in either mode.

Playwright is an optional extra (`agentos-desktop[browser]`) — Core never
imports it at import time; it appears only inside the browser-agent subprocess
payload.

Python 3.11 through 3.13 are supported and tested in CI.

## Engine

Core hosts **OpenCode** as the execution engine (agents, tools, sessions,
events). Core manages its process lifecycle and wraps it with the desktop
shell, storage, providers, and UI. It does not reimplement that engine.
