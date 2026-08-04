"""
AgentOS Core — a generic runtime for executing AI-driven workflows that are
defined entirely outside the Core (in applications under ``apps/``).

Public API (the stable Core↔App contract):

    from agentos import run, AppConfig, WorkspaceFolder

    run(AppConfig(
        app_id="my-app",
        app_title="My App",
        app_root=Path(__file__).parent,
        workspace_folders=(WorkspaceFolder("inbox", "inbox"), ...),
    ))

Core contains no domain knowledge. Swapping this Core for any other Core that
implements the same public API must leave every app running unchanged.
"""
from .config import AppConfig, WorkspaceFolder
from .runtime import run

__all__ = ["run", "AppConfig", "WorkspaceFolder"]
__version__ = "0.2.0"
