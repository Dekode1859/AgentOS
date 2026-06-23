# Learning OS

An AgentOS application for LLM-driven personal learning. It is the **reference
implementation** that AgentOS Core was extracted from.

Learning OS owns only domain concerns:

- **Agents** (`opencode.json`): `curriculum`, `session-planner`, `recap`
- **Workspace taxonomy** (`main.py` → `workspace_folders`): `raw`, `processed`,
  `knowledge`, `curriculum`, `sessions`
- **Workspace data** (`workspace/`): the markdown vault
- **Branding**: title "Learning OS"

Everything else — the window, OpenCode runtime, chat UI, streaming, sessions,
storage primitives, providers — comes from [AgentOS Core](../../core/).

## Run

```bash
make install      # uv sync
make auth-setup   # add a provider credential (isolated to .opencode-home/)
make run          # uv run python main.py
```

Requires the `opencode` CLI on your PATH:
`curl -fsSL https://opencode.ai/install | bash`

## How it consumes Core

`main.py` adds the sibling `core/` to `sys.path`, constructs an `AppConfig`, and
calls `agentos.run(APP)`. That single object is the entire Core↔App seam — no
Core file references Learning OS.
