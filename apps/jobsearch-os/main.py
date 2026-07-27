"""
CareerForge - an AgentOS application.

V0 scope: a Profile ("About Me") workspace. Upload / paste candidate documents,
extract a structured profile via the `profile` agent, render and edit it.

Like every AgentOS app, this is only configuration + domain assets. Execution
(window, OpenCode runtime, storage, providers) comes from AgentOS Core. This app
ships its own UI (an About Me dashboard) via AppConfig.ui_dir.
"""
from pathlib import Path
import sys

# Consume AgentOS Core as a shared source dir (monorepo).
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "core"))

from agentos import run, AppConfig, WorkspaceFolder

from bridge import JobSearchBridge


APP = AppConfig(
    app_id="jobsearch-os",
    app_title="CareerForge",
    app_root=Path(__file__).resolve().parent,
    ui_dir="ui",                      # this app ships its own front-end
    bridge_cls=JobSearchBridge,        # adds the embedded application browser
    workspace_dirname="workspace",
    workspace_folders=(
        WorkspaceFolder("documents", "file-text", "documents"),
        WorkspaceFolder("profile",   "user",      "profile"),
    ),
    default_capture_folder="documents",
    default_agent="profile",
)


if __name__ == "__main__":
    run(APP)
