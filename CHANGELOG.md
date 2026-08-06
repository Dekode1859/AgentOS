# Changelog

All notable changes to AgentOS Core are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

The version is single-sourced from `project.version` in `pyproject.toml`.
Bumping it is what requests a release: when the change lands on `main`, CI tags
the new version and publishes it. Leaving it alone releases nothing.

## [Unreleased]

## [0.3.1] — 2026-08-07

### Fixed
- **A bundled app wrote its user data to a macOS path on every platform.**
  `app_data_dir` — where a frozen app keeps its workspace, `opencode.json`, and
  `.opencode-home`, since it cannot write beside itself — was hardcoded to
  `~/Library/Application Support/<app_id>`. On Windows that resolved to
  `C:\Users\<user>\Library\Application Support\<app_id>`, a directory no
  convention owns, and on Linux likewise. It never raised: the directory was
  created on demand, so a packaged app appeared to work while scattering user
  data somewhere nobody would look for it, and an OS-level backup or migration
  would skip it. Now `%LOCALAPPDATA%` on Windows, `$XDG_DATA_HOME` (falling back
  to `~/.local/share`) on Linux, and the unchanged Application Support path on
  macOS. Every branch is asserted on every host, since picking the wrong one
  produces no error to catch.

## [0.3.0] — 2026-08-06

### Changed
- **Breaking (packaging only): the distribution is now `agentos-desktop`.** The
  import name is unchanged — code still says `import agentos`, the wheel still
  ships the `agentos` package, and the `agentos` console script keeps its name.
  Only the string you depend on changes:

  ```toml
  dependencies = ["agentos-desktop[browser]"]

  [tool.uv.sources]
  agentos-desktop = { git = "https://github.com/Dekode1859/AgentOS", tag = "v0.3.0" }
  ```

  The bare name `agentos` on PyPI belongs to an unrelated reinforcement-learning
  project, abandoned since 2022; `agentos-core` and `agentos-runtime` are held
  by two further unrelated projects. A dependency on the bare name therefore
  resolves *successfully* to someone else's package instead of failing, which is
  the worst available failure mode. Publishing under a name nobody else holds
  removes that hazard. No public API changed, so no application code changes
  beyond the dependency string.
- **The version is now single-sourced from `pyproject.toml`.** It used to live
  in `agentos/__init__.py`, with the build reading it out via
  `[tool.hatch.version]`; that relationship is now inverted.
  `agentos.__version__` is derived at import from the installed distribution's
  metadata, so it reports the version the running copy was *installed from*
  instead of a hardcoded literal that a working tree can silently outrun. The
  attribute keeps its name, type, and meaning, so nothing that reads it changes.
  Uninstalled source trees fall back to reading the adjacent `pyproject.toml`.

## [0.2.0] — 2026-08-05

First release packaged for installation from outside the repository.

### Added
- **Engine provisioning.** The OpenCode engine is a ~60 MB native binary that a
  pure-Python wheel cannot carry, and it was previously an undeclared
  prerequisite: Core called `shutil.which("opencode")` and, when it found
  nothing, warned and ran on with every agent dead. There is now an
  `agentos.engine` module and a CLI:

  ```bash
  agentos install-engine     # fetch the pinned build into a per-user cache
  agentos engine-info        # resolution source, version, supported range
  agentos engine-path
  ```

  Resolution is `AGENTOS_OPENCODE_BIN` → PATH → per-user cache. Downloading is
  never implicit: `run()` only resolves, and an app calls `engine.ensure()` from
  its own bootstrap if it wants a one-time install. A missing engine now fails
  startup with a message naming the command to run.
- **Engine version checking.** Core drives several of the engine's HTTP
  endpoints against what was previously a completely unpinned server. It now
  declares a supported range, reads the launched engine's version, and warns on
  a mismatch instead of failing mysteriously later. `OpenCodeServer.engine_version`
  exposes it.
- `agentos` is now a real distribution, installable straight from git:
  `uv add "agentos @ git+https://github.com/Dekode1859/AgentOS@v0.2.0"`.
  The shared UI ships as package data, so `resource_path("ui")` resolves inside
  site-packages.
- `browser` optional extra for Playwright, which Core needs only for the
  browser-agent subprocess and never imports at import time.
- Test suite covering the `AppConfig` contract, storage primitives, path
  resolution, agent loading, provider configuration, engine provisioning,
  process lifecycle, and multipart parsing.
- An executable form of the project's central rule: a test that fails if Core
  source contains domain vocabulary.
- **A swap-invariant baseline.** The frozen apps under `apps/` are now loaded
  against the current Core in the test suite, so a change that would break a
  real application fails here first. Core's public API and its JS-callable
  bridge surface are pinned as explicit lists; app front-ends call bridge
  methods by string, so a rename otherwise passes every import and type check
  and only fails when a user clicks. The `apps` dependency group installs what
  those apps need, and CI fails if the baseline skips rather than runs.
- CI across Linux, macOS, and Windows on Python 3.11–3.13, plus a job that
  installs the package from its own git URL and smoke-tests the result.

### Changed
- **Breaking:** the package moved from `core/agentos/` to `agentos/` at the
  repository root, so installs no longer need a `#subdirectory=core` fragment.
  Apps consuming Core as shared source must drop `/ "core"` from their
  `sys.path` line.
- **Breaking:** `Bridge.export_resume_pdf` is now `Bridge.export_pdf`. The
  implementation was always generic — it renders arbitrary HTML — and the old
  name violated the rule that Core carries no domain vocabulary. Callers must
  update the bridge method name; the signature is unchanged.
- Python 3.13 is supported. `runtime/shell.py` no longer imports the stdlib
  `cgi` module, removed in 3.13, so `import agentos` failed outright there.
  Multipart uploads are parsed with `email` instead, with identical behavior for
  the `files` field.

### Fixed
- **The engine outlived the app on every exit.** `OpenCodeServer.stop()`
  terminated only its direct child, but the `opencode` launcher on PATH is a
  wrapper (an npm shim on Windows) that execs the real binary as a
  *grandchild*. Killing the wrapper left the engine running, reparented and
  holding its port — one orphaned process per app launch. `stop()` now takes
  the whole process tree (`taskkill /T` on Windows, process-group signal
  elsewhere), and the engine is started in its own process group on POSIX so
  the group signal has something to target.

  A force quit — Task Manager, `taskkill /F`, a crash — runs no `atexit`, no
  `finally`, and no signal handler, so cooperative shutdown cannot help there.
  On Windows the engine is now also assigned to a Job Object with
  `KILL_ON_JOB_CLOSE`, which makes the kernel terminate it when the app dies
  for any reason. Best effort: if the job cannot be created, behavior falls
  back to cooperative shutdown. POSIX still relies on the process group, so a
  `SIGKILL` of the app there can still leave the engine behind.
- **Path traversal in `storage._safe`.** Containment was checked with a string
  prefix comparison, so a sibling directory whose name began with the root's
  name (root `…/workspace`, target `…/workspace-evil`) was accepted as inside
  the root. Reads, writes, and deletes could therefore escape the workspace.
  Containment is now checked against the resolved path hierarchy.

## 0.1.0 — never released

Recorded for continuity only: this version existed solely as shared source
inside the monorepo, was never tagged, and no artifact was ever published for
it. Initial extraction of the runtime from the first application. Core↔App contract
(`AppConfig`, `WorkspaceFolder`, `run()`), desktop shell, OpenCode process
lifecycle, storage primitives, provider abstraction, and the shared chat UI.
Consumed only as shared source inside the monorepo.

[Unreleased]: https://github.com/Dekode1859/AgentOS/compare/v0.3.1...HEAD
[0.3.1]: https://github.com/Dekode1859/AgentOS/releases/tag/v0.3.1
[0.3.0]: https://github.com/Dekode1859/AgentOS/releases/tag/v0.3.0
[0.2.0]: https://github.com/Dekode1859/AgentOS/releases/tag/v0.2.0
