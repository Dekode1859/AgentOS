"""
UI Bridge — the JS↔Python API exposed via PyWebView.

Generic plumbing only. Every method either:
  - relays app-supplied configuration to the UI (get_config), or
  - performs a generic operation (storage CRUD, provider auth, dialogs).

The bridge holds an ``AppConfig`` but treats its domain fields as opaque data
to forward — it never branches on what the app *is*.
"""
from __future__ import annotations

from pathlib import Path

import webview

from . import agents as agents_mod
from . import providers as providers_mod
from . import storage
from .config import AppConfig
from .runtime import paths
from .runtime.server import OpenCodeServer


class Bridge:
    def __init__(self, config: AppConfig, server: OpenCodeServer):
        self._config = config
        self._server = server
        self._project_root = paths.project_root(config.app_root, config.app_id)
        self._workspace = paths.workspace_path(
            config.app_root, config.app_id, config.workspace_dirname
        )
        # Ensure the app's declared folders exist (names come from the app).
        storage.ensure_dirs(self._workspace, config.folder_names())

    # ── Config ───────────────────────────────────────────────────────────────
    def get_config(self) -> dict:
        """Everything the UI needs, including app-supplied branding/taxonomy."""
        return {
            "opencode_port": self._server.port,
            "workspace_path": str(self._workspace),
            "project_path": str(self._project_root),
            "app_title": self._config.app_title,
            "app_id": self._config.app_id,
            "workspace_folders": self._config.folders_payload(),
            "agents": agents_mod.load_agents(self._project_root),
            "default_model": agents_mod.default_model(self._project_root),
            "default_agent": self._config.default_agent,
            "default_capture_folder": self._config.default_capture_folder,
        }

    # ── Providers / Auth ───────────────────────────────────────────────────────
    def get_providers(self) -> dict:
        return providers_mod.list_providers(self._server.port)

    def save_provider_key(self, provider_id: str, api_key: str) -> dict:
        try:
            providers_mod.save_key(self._server.home_dir, provider_id, api_key)
            self._server.stop()
            new_port = self._server.start()
            return {"ok": True, "port": new_port}
        except Exception as e:
            return {"ok": False, "error": str(e)}

    def remove_provider_key(self, provider_id: str) -> dict:
        try:
            providers_mod.remove_key(self._server.home_dir, provider_id)
            self._server.stop()
            new_port = self._server.start()
            return {"ok": True, "port": new_port}
        except Exception as e:
            return {"ok": False, "error": str(e)}

    def set_default_model(self, provider_id: str, model_id: str) -> dict:
        try:
            res = providers_mod.set_default_model(self._project_root, provider_id, model_id)
            self._server.stop()
            new_port = self._server.start()
            return {"ok": True, "model": res["model"], "port": new_port}
        except Exception as e:
            return {"ok": False, "error": str(e)}

    # ── Workspace / Storage ─────────────────────────────────────────────────────
    def workspace_tree(self) -> dict:
        """Folder tree with counts. Folder list is app-defined; Core just counts."""
        tree = {}
        for f in self._config.workspace_folders:
            tree[f.name] = {
                "count": storage.count_dir(self._workspace, f.name),
                "path": f.name,
                "icon": f.icon,
                "label": f.display(),
            }
        return tree

    def workspace_list(self, folder: str = "") -> list:
        return storage.list_dir(self._workspace, folder)

    def workspace_read(self, rel_path: str) -> dict:
        return storage.read(self._workspace, rel_path)

    def workspace_write(self, rel_path: str, content: str) -> dict:
        return storage.write(self._workspace, rel_path, content)

    def workspace_delete(self, rel_path: str) -> dict:
        return storage.delete(self._workspace, rel_path)

    def workspace_new_note_path(self, title: str = "") -> str:
        folder = self._config.default_capture_folder or ""
        return storage.timestamped_name(folder, title) if folder else ""

    # ── Dialogs ──────────────────────────────────────────────────────────────
    def open_folder_dialog(self) -> str:
        result = webview.windows[0].create_file_dialog(webview.FOLDER_DIALOG)
        if result:
            return result[0] if isinstance(result, (list, tuple)) else result
        return ""
