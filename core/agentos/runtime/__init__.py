"""Execution runtime: desktop shell, OpenCode lifecycle, path resolution."""
from .shell import run
from .server import OpenCodeServer
from . import paths

__all__ = ["run", "OpenCodeServer", "paths"]
