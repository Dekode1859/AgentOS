#!/usr/bin/env python3
"""
Run the whole test suite (Python bridge tests + JS app tests).

The Python tests need `webview`, which lives in the jobsearch-os venv, so we
invoke that interpreter explicitly. The JS tests need `node` on PATH.

    python tests/run_all.py
"""
from __future__ import annotations

import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
VENV_PY = ROOT / "apps" / "jobsearch-os" / ".venv" / "Scripts" / "python.exe"
if not VENV_PY.exists():  # POSIX layout fallback
    VENV_PY = ROOT / "apps" / "jobsearch-os" / ".venv" / "bin" / "python"


def run(label: str, cmd: list[str]) -> int:
    print(f"\n=== {label} ===")
    return subprocess.run(cmd, cwd=ROOT).returncode


def main() -> int:
    py = str(VENV_PY) if VENV_PY.exists() else sys.executable
    rc = 0
    rc |= run("Python (bridge)", [py, "-m", "unittest", "tests.test_bridge"])
    rc |= run("JavaScript (app.js)", ["node", "tests/test_app.mjs"])
    print("\n" + ("ALL GREEN" if rc == 0 else "FAILURES ABOVE"))
    return rc


if __name__ == "__main__":
    sys.exit(main())
