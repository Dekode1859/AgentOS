"""
Learning OS — a personal, LLM-driven learning platform.

This file is the *entire* application bootstrap. All execution mechanics
(window, OpenCode runtime, sessions, streaming, storage, providers) live in
AgentOS Core. Learning OS only declares its identity and domain configuration:
its workspace taxonomy and the agents defined in opencode.json.
"""
from pathlib import Path
import sys

# AgentOS Core is consumed as a shared source directory (monorepo): add the
# sibling core/ to the path so `import agentos` resolves. Swapping the Core
# implementation behind this path requires no change to this app.
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "core"))

from agentos import run, AppConfig, WorkspaceFolder


APP = AppConfig(
    app_id="learning-os",
    app_title="Learning OS",
    app_root=Path(__file__).resolve().parent,
    workspace_dirname="workspace",
    # The learning workspace taxonomy. Core is blind to what these mean.
    workspace_folders=(
        WorkspaceFolder("raw",        "inbox",          "raw"),
        WorkspaceFolder("processed",  "file-check-2",   "processed"),
        WorkspaceFolder("knowledge",  "brain",          "knowledge"),
        WorkspaceFolder("curriculum", "graduation-cap", "curriculum"),
        WorkspaceFolder("sessions",   "calendar-days",  "sessions"),
    ),
    default_capture_folder="raw",
    # Preferred default agent on launch (must match a key in opencode.json).
    default_agent="session-planner",
)


if __name__ == "__main__":
    run(APP)
