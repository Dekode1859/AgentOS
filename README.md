# AgentOS

A deterministic runtime engine for executing AI-driven workflows that are
defined **entirely outside** the core system. AgentOS is not a framework, a
library, or a template — it is a **runtime with a swapable core**.

## The architectural invariant

> Replace the Core of any AgentOS app with the Core of another and both must
> still run unmodified. Delete any app and Core remains unchanged and
> functional.

Core owns **how** execution happens (runtime, sessions, streaming, storage
primitives, providers, UI bus). Apps own **what** the system does (agents,
prompts, schemas, workspace meaning, branding).

## Layout

```
AgentOS/
├── core/                      # AgentOS Core — generic runtime (no domain knowledge)
│   └── agentos/
│       ├── __init__.py        # public API: run(), AppConfig, WorkspaceFolder
│       ├── config.py          # the Core↔App contract
│       ├── runtime/           # desktop shell, OpenCode lifecycle, paths
│       ├── storage/           # generic file primitives (no folder semantics)
│       ├── providers/         # LLM provider abstraction
│       ├── agents/            # reads app-declared agents (executes none)
│       ├── tools/             # delegated to OpenCode (see README)
│       ├── events/            # OpenCode SSE → UI bus (see README)
│       ├── bridge.py          # JS↔Python UI bridge
│       └── ui/                # generic chat UI (branding via config)
├── apps/
│   ├── learning-os/           # reference implementation (consumes Core)
│   └── jobsearch-os/          # scaffold for the next app (no logic yet)
└── docs/
    ├── architecture-audit.md  # Phase 1: what was extracted and why
    └── parity-checklist.md    # Phase 3: behavioral equivalence
```

## Run an app

```bash
cd apps/learning-os
make install
make auth-setup     # add a provider credential
make run
```

Requires the `opencode` CLI on PATH:
`curl -fsSL https://opencode.ai/install | bash`

## The Core↔App contract

An app is a `main.py` that declares an `AppConfig` and calls `agentos.run()`:

```python
import sys; from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "core"))
from agentos import run, AppConfig, WorkspaceFolder

run(AppConfig(
    app_id="learning-os",
    app_title="Learning OS",
    app_root=Path(__file__).resolve().parent,
    workspace_folders=(WorkspaceFolder("raw", "inbox"), ...),
    default_agent="session-planner",
))
```

That object is the **only** place an app injects identity into Core. No Core
file references any app — see `docs/architecture-audit.md`.

## Status

- ✅ Phase 1 — Architecture audit
- ✅ Phase 2 — AgentOS Core extracted (domain-clean)
- ✅ Phase 3 — Learning OS migrated onto Core; parity checklist
- ▫️ Phase 4 — Job Search OS: scaffold only (V0/V1/V2 are future work)
