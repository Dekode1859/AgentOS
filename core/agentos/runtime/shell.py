"""
Desktop shell: the generic PyWebView window + local UI HTTP server + lifecycle.

This is the Core entry point an application calls via ``agentos.run(config)``.
It is application-independent: the only app-specific input is the ``AppConfig``.
"""
from __future__ import annotations

import http.server
import os
import sys
import threading

from ..config import AppConfig
from . import paths
from .server import OpenCodeServer


def _load_env(config: AppConfig):
    """Load .env into os.environ before anything else reads it."""
    for env_path in paths.env_candidates(config.app_root, config.app_id):
        if env_path.exists():
            with open(env_path) as f:
                for line in f:
                    line = line.strip()
                    if line and not line.startswith("#") and "=" in line:
                        k, v = line.split("=", 1)
                        v = v.strip().strip('"').strip("'")
                        os.environ.setdefault(k, v)
            break


def _set_app_name(title: str):
    """Best-effort: set the macOS menu-bar app name in dev runs."""
    if paths.is_bundled():
        return
    try:
        from Foundation import NSBundle
        info = NSBundle.mainBundle().infoDictionary()
        info["CFBundleName"] = title
        info["CFBundleDisplayName"] = title
    except Exception:
        pass


def _start_ui_server(ui_dir: str) -> int:
    """Serve the Core UI over http://127.0.0.1 with no-cache headers.

    Serving over HTTP (not file://) makes WKWebView apply standard CORS to the
    UI's fetch() calls to OpenCode, and no-cache guarantees fresh assets.
    """
    class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
        def __init__(self, *args, **kwargs):
            super().__init__(*args, directory=ui_dir, **kwargs)

        def end_headers(self):
            self.send_header("Cache-Control", "no-cache, no-store, must-revalidate")
            self.send_header("Pragma", "no-cache")
            super().end_headers()

        def log_message(self, *args):
            pass

    server = http.server.HTTPServer(("127.0.0.1", 0), NoCacheHandler)
    port = server.server_address[1]
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return port


def run(config: AppConfig):
    """Boot an AgentOS application. Blocks until the window is closed."""
    import webview  # imported late so non-GUI tooling can import agentos cleanly

    from ..bridge import Bridge  # late import to avoid a cycle

    _load_env(config)
    _set_app_name(config.app_title)

    proot = paths.project_root(config.app_root, config.app_id)
    opencode = OpenCodeServer(proot, port_env_var=config.env_port_var)
    try:
        opencode.start()
    except RuntimeError as e:
        print(f"[agentos] WARNING: {e}", file=sys.stderr)
        print("[agentos] Continuing without OpenCode — chat will not function.",
              file=sys.stderr)

    bridge = Bridge(config, opencode)

    # Serve the app's own UI if it provides one; otherwise the shared chat UI.
    ui_dir = str(config.ui_dir) if config.ui_dir else str(paths.resource_path("ui"))
    ui_port = _start_ui_server(ui_dir)

    window = webview.create_window(
        title=config.app_title,
        url=f"http://127.0.0.1:{ui_port}/index.html",
        js_api=bridge,
        width=config.window_size[0],
        height=config.window_size[1],
        min_size=config.min_size,
    )
    window.events.closed += lambda: opencode.stop()
    webview.start(debug=False)
