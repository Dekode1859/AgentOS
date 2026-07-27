"""
App-specific bridge additions for the embedded application browser.

Subclasses AgentOS Core's generic ``Bridge`` rather than editing it — the
embedded-browser feature (streaming a headless Chromium into the Application
tab, replaying input into it) is entirely job-search domain, so it lives here
per the Core purity rule, not in ``core/agentos/bridge.py``.

The existing side-by-side ``browser_open`` flow (used today for one-time
Google/LinkedIn sign-in under Settings > Browser Account) is untouched and
still comes from Core — it's low-frequency and already works. This subclass
only adds the new embedded-view methods used by the Application tab, and they
share the same persistent profile directory so a login from one flow is
visible to the other.
"""
from __future__ import annotations

import json
import subprocess
import sys
import threading
import urllib.request
from pathlib import Path

from agentos.bridge import Bridge

_AGENT_SCRIPT = Path(__file__).with_name("browser_embed_agent.py")


class JobSearchBridge(Bridge):
    def __init__(self, config, server):
        super().__init__(config, server)
        self._embed_proc = None
        self._embed_port = None

    # ── Embedded application browser ────────────────────────────────────────
    def browser_embed_open(self, url: str, width: int = 1280, height: int = 900) -> dict:
        """Launch the headless embedded-browser subprocess for the Application tab.

        Returns {ok, port}; the frontend points an <img> at
        http://127.0.0.1:{port}/stream and POSTs input to the same port.
        """
        self._embed_close_internal()
        profile_dir = str(self._workspace / "browser-profile")
        try:
            proc = subprocess.Popen(
                [sys.executable, str(_AGENT_SCRIPT), url, profile_dir, str(width), str(height)],
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
            )
            line = proc.stdout.readline()
            if not line:
                err = proc.stderr.read(800)
                return {"ok": False, "error": err or "embedded browser failed to start"}
            info = json.loads(line.strip())
            if not info.get("ok"):
                proc.terminate()
                return info
            self._embed_proc = proc
            self._embed_port = info["port"]
            threading.Thread(target=self._watch_embed_exit, args=(proc,), daemon=True).start()
            return {"ok": True, "port": info["port"]}
        except Exception as e:
            return {"ok": False, "error": str(e)}

    def browser_embed_close(self) -> dict:
        return self._embed_close_internal()

    def browser_embed_status(self) -> dict:
        return self._embed_request("status", timeout=5)

    def browser_embed_navigate(self, url: str) -> dict:
        return self._embed_request("navigate", data={"url": url}, timeout=25)

    def browser_embed_back(self) -> dict:
        return self._embed_request("back", timeout=15)

    def browser_embed_forward(self) -> dict:
        return self._embed_request("forward", timeout=15)

    def browser_embed_reload(self) -> dict:
        return self._embed_request("reload", timeout=15)

    def browser_embed_file_chooser_pending(self) -> dict:
        port = self._embed_port
        if not port:
            return {"ok": False, "pending": False}
        try:
            with urllib.request.urlopen(f"http://127.0.0.1:{port}/file-chooser", timeout=5) as resp:
                return json.loads(resp.read().decode())
        except Exception as e:
            return {"ok": False, "error": str(e), "pending": False}

    def browser_embed_choose_files(self) -> dict:
        """Open the native OS file picker, then hand the chosen paths to
        whichever <input type=file> is currently waiting on the embedded page."""
        paths = self.open_file_dialog()
        if not paths:
            return {"ok": False, "error": "No files chosen"}
        return self._embed_request("set-files", data={"paths": paths}, timeout=15)

    def _embed_request(self, path: str, data: dict | None = None, timeout: int = 15) -> dict:
        port = self._embed_port
        if not port:
            return {"ok": False, "error": "Embedded browser not open"}
        try:
            req = urllib.request.Request(
                f"http://127.0.0.1:{port}/{path}",
                method="POST",
                data=json.dumps(data or {}).encode(),
                headers={"Content-Type": "application/json"},
            )
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                return json.loads(resp.read().decode())
        except Exception as e:
            return {"ok": False, "error": str(e)}

    def _embed_close_internal(self) -> dict:
        proc = self._embed_proc
        port = self._embed_port
        if proc:
            if port:
                try:
                    req = urllib.request.Request(
                        f"http://127.0.0.1:{port}/stop",
                        method="POST", data=b"{}",
                        headers={"Content-Type": "application/json"},
                    )
                    urllib.request.urlopen(req, timeout=2)
                except Exception:
                    pass
            try:
                proc.terminate()
                proc.wait(timeout=3)
            except Exception:
                pass
            self._embed_proc = None
            self._embed_port = None
        return {"ok": True}

    def _watch_embed_exit(self, proc) -> None:
        try:
            proc.wait()
        except Exception:
            pass
        if self._embed_proc is proc:
            self._embed_proc = None
            self._embed_port = None
        try:
            import webview
            if webview.windows:
                webview.windows[0].evaluate_js(
                    'typeof _onEmbeddedBrowserDied === "function" && _onEmbeddedBrowserDied()'
                )
        except Exception:
            pass
