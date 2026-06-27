# Tests

Characterization tests that lock the current behavior of Core and the Job Search
OS UI so the codebase can be refactored safely. They assert *what the apps do
today* — if a refactor is meant to be behavior-preserving, these must stay green.

## Run everything

```bash
python tests/run_all.py
```

## Run individually

```bash
# Python — Bridge (storage, browser profile, server restart, tile layout).
# Needs `webview`, which is in the jobsearch-os venv:
apps/jobsearch-os/.venv/Scripts/python.exe -m unittest tests.test_bridge -v

# JavaScript — app.js pure functions (render snapshots, JSON parsers, merge):
node tests/test_app.mjs
```

## What's here

| File | Covers |
|------|--------|
| `test_bridge.py` | `core/agentos/bridge.py` — storage CRUD, profile status/reset, browser guards, the provider server-restart methods, tile-layout geometry, and a `compile()` guard on the embedded browser-agent script. |
| `test_app.mjs` | `apps/jobsearch-os/ui/app.js` — golden snapshots of every section view/edit renderer, the resume + export HTML, JD/form renderers; structural tests for `mergeProfile` and the JSON parsers. |
| `__snapshots__/app-snapshots.json` | Golden output captured from the baseline. Delete a key (or the file) to re-record. |

### How the JS harness works

`app.js` is a browser script, not a module. The harness loads it with
`new Function`, stubs `window`, strips the trailing `init()` call, and appends an
export object — so the pure functions can be exercised in Node with zero deps.
Only functions that don't touch the DOM are tested.

### Snapshots

First run records snapshots and prints `N snapshots created`. Later runs compare.
A behavior-preserving refactor should produce **byte-identical** output and stay
green; if a change is intended, delete the affected key from the snapshot file
and re-run to re-record.
