"""
Path resolution — works in both dev and PyInstaller .app bundles.

Generic: the only app-specific input is ``app_id`` (e.g. "learning-os"), which
the application supplies via ``AppConfig``. Core hardcodes no app name.

Dev layout:    app_root / opencode.json, workspace/ ...
Bundle layout: sys._MEIPASS (read-only extracted resources)
               ~/Library/Application Support/<app_id>/ (writable user data)
"""
from __future__ import annotations

import os
import sys
from pathlib import Path


def is_bundled() -> bool:
    return getattr(sys, "frozen", False) and hasattr(sys, "_MEIPASS")


def resource_path(relative: str) -> Path:
    """Path to a read-only bundled resource (the Core ui/ dir, etc.)."""
    if is_bundled():
        return Path(sys._MEIPASS) / relative
    # Core resources live next to this package.
    return Path(__file__).resolve().parent.parent / relative


def app_data_dir(app_id: str) -> Path:
    """Writable directory for an app's user data.

    Dev: returns None-equivalent handled by caller (app_root is used instead).
    Bundle: ~/Library/Application Support/<app_id>/
    """
    d = Path.home() / "Library" / "Application Support" / app_id
    d.mkdir(parents=True, exist_ok=True)
    return d


def project_root(app_root: Path, app_id: str) -> Path:
    """Where the app's opencode.json + workspace live at runtime."""
    if is_bundled():
        return app_data_dir(app_id)
    return Path(app_root)


def workspace_path(app_root: Path, app_id: str, dirname: str) -> Path:
    """Resolve the app's workspace (data) root, honoring WORKSPACE_PATH.

    ``dirname`` and any folder semantics are supplied by the app — Core only
    joins paths and ensures the root exists.
    """
    env_ws = os.environ.get("WORKSPACE_PATH", "").strip()
    if env_ws:
        p = Path(env_ws)
    else:
        p = project_root(app_root, app_id) / dirname
    p.mkdir(parents=True, exist_ok=True)
    return p


def env_candidates(app_root: Path, app_id: str) -> list[Path]:
    """Ordered list of .env locations to try."""
    if is_bundled():
        return [
            app_data_dir(app_id) / ".env",
            Path(sys._MEIPASS) / ".env",
        ]
    return [Path(app_root) / ".env"]
