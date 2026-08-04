"""Shared pytest setup.

Two kinds of suite live here. The ``test_agentos_*`` files test the Core package
itself and run anywhere. The characterization suites (``test_bridge``,
``test_lexicon_*``, ``test_runtime_shell_api``) lock the behavior of the example
apps and need those apps' dependencies; they are run locally through
``tests/run_all.py`` against the app venvs. Against a bare install of the
package they are skipped rather than failed, so CI stays honest about what it
actually exercised.
"""
from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))


def _importable(module: str) -> bool:
    try:
        return importlib.util.find_spec(module) is not None
    except (ImportError, ValueError):
        return False


collect_ignore_glob: list[str] = []

# apps/learning-os deps: bs4, pypdf, ebooklib, markdownify.
if not (_importable("bs4") and _importable("pypdf")):
    collect_ignore_glob.append("test_lexicon_*.py")

# bridge.py imports webview at module scope, which needs a GUI toolkit present.
if not _importable("webview"):
    collect_ignore_glob.append("test_bridge.py")
