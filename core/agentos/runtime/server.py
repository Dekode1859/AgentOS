"""
OpenCode `serve` subprocess lifecycle.

Core hosts OpenCode as the generic execution engine (agents, tools, sessions,
events). This module only manages the process: start on a port, isolate HOME,
poll until ready, stop. It has no knowledge of agents or domains.

OpenCode is launched with HOME pointed at <project>/.opencode-home so that all
provider credentials, sessions, and config are isolated from the user's global
opencode installation, per-app.
"""
from __future__ import annotations

import os
import shutil
import socket
import subprocess
import time
from pathlib import Path

import requests


class OpenCodeServer:
    """One running ``opencode serve`` instance, scoped to a project directory."""

    def __init__(self, project_root: Path, port_env_var: str = "OPENCODE_PORT"):
        self._project_root = Path(project_root)
        self._port_env_var = port_env_var
        self._process: subprocess.Popen | None = None
        self._port: int | None = None

    @property
    def home_dir(self) -> Path:
        d = self._project_root / ".opencode-home"
        d.mkdir(exist_ok=True)
        return d

    @staticmethod
    def _find_free_port() -> int:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            s.bind(("127.0.0.1", 0))
            return s.getsockname()[1]

    def start(self) -> int:
        opencode_bin = shutil.which("opencode")
        if not opencode_bin:
            raise RuntimeError(
                "opencode not found in PATH. Install it with: "
                "curl -fsSL https://opencode.ai/install | bash"
            )

        configured = int(os.environ.get(self._port_env_var, "0"))
        port = configured if configured > 0 else self._find_free_port()

        # Isolate opencode: override HOME so its data/config/auth are project-local.
        env = os.environ.copy()
        env["HOME"] = str(self.home_dir)
        env.setdefault("PATH", os.environ.get("PATH", ""))

        self._process = subprocess.Popen(
            [opencode_bin, "serve", "--port", str(port)],
            cwd=str(self._project_root),
            env=env,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )

        deadline = time.time() + 20
        while time.time() < deadline:
            try:
                r = requests.get(f"http://127.0.0.1:{port}/session", timeout=1)
                if r.status_code == 200:
                    self._port = port
                    return port
            except Exception:
                pass
            time.sleep(0.3)

        self._process.kill()
        raise RuntimeError(
            f"opencode server did not become ready on port {port} within 20 seconds"
        )

    def stop(self):
        if self._process is not None:
            try:
                self._process.terminate()
                self._process.wait(timeout=5)
            except Exception:
                try:
                    self._process.kill()
                except Exception:
                    pass
            self._process = None

    @property
    def port(self) -> int | None:
        return self._port
