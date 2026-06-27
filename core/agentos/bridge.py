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

# ── Browser agent subprocess script ──────────────────────────────────────────
# Launched by browser_open(); runs headed Playwright Chromium.
# Exposes a local HTTP control API: GET /ping /status, POST /navigate /focus /stop
# The main thread runs the Playwright event loop via a command queue;
# a daemon thread runs the HTTP server.
_BROWSER_AGENT = r'''
import sys, json, queue as _q, threading, os
from http.server import HTTPServer, BaseHTTPRequestHandler
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright

_cmd_q, _res_q = _q.Queue(), _q.Queue()
# Set by Playwright's event thread when the active page is closed by the user.
_page_closed = threading.Event()

class _H(BaseHTTPRequestHandler):
    def log_message(self, *_): pass

    def _j(self, d, code=200):
        b = json.dumps(d).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Content-Length", str(len(b)))
        self.end_headers()
        self.wfile.write(b)

    def _dispatch(self, cmd, timeout=20):
        _cmd_q.put(cmd)
        try:
            return _res_q.get(timeout=timeout)
        except _q.Empty:
            return {"ok": False, "error": "timeout"}

    def do_GET(self):
        path = urlparse(self.path).path
        if path == "/ping":
            self._j({"ok": True})
        elif path == "/status":
            self._j(self._dispatch({"t": "status"}, timeout=5))
        else:
            self._j({"ok": False, "error": "not found"}, 404)

    def do_OPTIONS(self):
        # CORS preflight — WKWebView sends OPTIONS before every non-simple request.
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_POST(self):
        path = urlparse(self.path).path
        n = int(self.headers.get("Content-Length", 0))
        body = json.loads(self.rfile.read(n)) if n else {}
        if path == "/navigate":
            self._j(self._dispatch({"t": "navigate", "url": body.get("url", "")}, timeout=25))
        elif path == "/focus":
            self._j(self._dispatch({"t": "focus"}, timeout=5))
        elif path == "/detect-fields":
            self._j(self._dispatch({"t": "detect_fields"}, timeout=15))
        elif path == "/check-google-login":
            self._j(self._dispatch({"t": "check_google_login"}, timeout=20))
        elif path == "/stop":
            _cmd_q.put({"t": "stop"})
            self._j({"ok": True})
        else:
            self._j({"ok": False, "error": "not found"}, 404)


def _watch_stdin():
    """Exit the agent when the parent process dies (stdin reaches EOF).
    This prevents orphan Chromium processes after a force-quit of the app."""
    try:
        sys.stdin.read()
    except Exception:
        pass
    os._exit(0)

threading.Thread(target=_watch_stdin, daemon=True).start()

_start_url = sys.argv[1] if len(sys.argv) > 1 else "about:blank"
# Args layout: url [left top width height] [user_data_dir]
# 5 remaining = bounds + user_data_dir; 4 = bounds only (legacy); 1 = user_data_dir only
_tile_bounds = None
_user_data_dir = ''
_remaining = sys.argv[2:]
if len(_remaining) == 5:
    try:
        _tile_bounds = {
            "left":        int(_remaining[0]),
            "top":         int(_remaining[1]),
            "width":       int(_remaining[2]),
            "height":      int(_remaining[3]),
            "windowState": "normal",
        }
    except (ValueError, IndexError):
        pass
    _user_data_dir = _remaining[4]
elif len(_remaining) == 4:
    try:
        _tile_bounds = {
            "left":        int(_remaining[0]),
            "top":         int(_remaining[1]),
            "width":       int(_remaining[2]),
            "height":      int(_remaining[3]),
            "windowState": "normal",
        }
    except (ValueError, IndexError):
        pass
elif len(_remaining) == 1:
    _user_data_dir = _remaining[0]

if _user_data_dir:
    import pathlib as _pl
    _lock = _pl.Path(_user_data_dir) / 'SingletonLock'
    try:
        if _lock.exists() or _lock.is_symlink():
            _lock.unlink()
    except Exception:
        pass

def _attach_page_listener(page):
    """Register close handler on a page; fires from Playwright's I/O thread."""
    page.on("close", lambda _p: _page_closed.set())

with sync_playwright() as _pw:
    _browser = None
    if _user_data_dir:
        import pathlib as _pl
        _pl.Path(_user_data_dir).mkdir(parents=True, exist_ok=True)
        _ctx = _pw.chromium.launch_persistent_context(
            _user_data_dir,
            headless=False,
            channel='chrome',
            viewport=None,
            ignore_default_args=['--enable-automation'],
            args=[
                '--disable-blink-features=AutomationControlled',
                '--no-first-run',
                '--no-default-browser-check',
            ],
        )
        _page = _ctx.pages[0] if _ctx.pages else _ctx.new_page()
    else:
        _browser = _pw.chromium.launch(headless=False)
        _ctx = _browser.new_context()
        _page = _ctx.new_page()
    _attach_page_listener(_page)

    # Position the Chromium window via CDP when tiling bounds were supplied.
    if _tile_bounds:
        import time as _t
        _t.sleep(0.15)  # brief pause for the OS window to appear
        try:
            _cdp = _ctx.new_cdp_session(_page)
            _ti  = _cdp.send("Target.getTargetInfo", {})
            _wi  = _cdp.send("Browser.getWindowForTarget",
                             {"targetId": _ti["targetInfo"]["targetId"]})
            _cdp.send("Browser.setWindowBounds",
                      {"windowId": _wi["windowId"], "bounds": _tile_bounds})
        except Exception:
            pass

    _server = HTTPServer(("127.0.0.1", 0), _H)
    threading.Thread(target=_server.serve_forever, daemon=True).start()

    # Signal ready before navigating so bridge.browser_open() returns fast.
    print(json.dumps({"ok": True, "port": _server.server_address[1]}), flush=True)

    try:
        _page.goto(_start_url, wait_until="domcontentloaded", timeout=20000)
    except Exception:
        pass

    while True:
        try:
            _c = _cmd_q.get(timeout=0.2)
        except _q.Empty:
            # Check if the user closed the active tab/page.
            if _page_closed.is_set():
                _page_closed.clear()
                try:
                    # Reopen a blank page so the browser window stays usable.
                    _page = _ctx.new_page()
                    _attach_page_listener(_page)
                except Exception:
                    break  # Browser itself was closed — exit cleanly.
            continue

        if _c.get("t") == "stop":
            break
        try:
            _t = _c["t"]
            if _t == "status":
                _res_q.put({"ok": True, "url": _page.url, "title": _page.title()})
            elif _t == "navigate":
                _page.goto(_c["url"], wait_until="domcontentloaded", timeout=20000)
                _res_q.put({"ok": True, "url": _page.url})
            elif _t == "focus":
                # CDP brings the specific tab to front within its Chrome window.
                _page.bring_to_front()
                # On macOS, activate by the exact PID Playwright launched —
                # not by bundle ID, which would match any running Chrome/Chromium.
                # Only available in non-persistent mode (_browser is not None).
                if sys.platform == "darwin" and _browser:
                    try:
                        from AppKit import NSRunningApplication, NSApplicationActivateIgnoringOtherApps
                        _chromium_pid = _browser.process.pid
                        _app = NSRunningApplication.runningApplicationWithProcessIdentifier_(_chromium_pid)
                        if _app:
                            _app.activateWithOptions_(NSApplicationActivateIgnoringOtherApps)
                    except Exception:
                        pass
                _res_q.put({"ok": True})
            elif _t == "detect_fields":
                _forms = _page.evaluate("""(function() {
  var TN={"text":"Text","email":"Email","password":"Password","number":"Number","tel":"Phone","url":"URL","date":"Date","datetime-local":"Date & Time","time":"Time","month":"Month","week":"Week","range":"Range","file":"File Upload","checkbox":"Checkbox","radio":"Radio","color":"Color","search":"Search","textarea":"Long Text","select":"Dropdown"};
  function lbl(el) {
    if (el.id) { try { var L=document.querySelector('label[for="'+el.id+'"]'); if(L) return L.innerText.trim(); } catch(e){} }
    var a=el.getAttribute('aria-label'); if(a) return a.trim();
    var lb=el.getAttribute('aria-labelledby');
    if(lb){var p=lb.split(' ').map(function(i){var d=document.getElementById(i);return d?d.innerText.trim():'';}).filter(function(s){return s;});if(p.length)return p.join(' ');}
    var pl=el.closest('label'); if(pl){var t=pl.innerText.replace(el.value||'','').trim();if(t)return t;}
    return el.placeholder||el.name||el.id||'';
  }
  function hlp(el){var db=el.getAttribute('aria-describedby');if(!db)return '';return db.split(' ').map(function(i){var d=document.getElementById(i);return d?d.innerText.trim():'';}).filter(function(s){return s;}).join(' ');}
  function proc(el){
    var tag=el.tagName.toLowerCase();
    var type=tag==='select'?'select':tag==='textarea'?'textarea':(el.type||'text').toLowerCase();
    if(['hidden','submit','button','reset','image'].indexOf(type)!==-1)return null;
    var f={type:type,typeName:TN[type]||type,label:lbl(el)||'Unlabeled Field',helperText:hlp(el),required:el.required||el.getAttribute('aria-required')==='true',name:el.name||el.id||''};
    if(tag==='select')f.options=Array.prototype.slice.call(el.options,0,25).filter(function(o){return o.value;}).map(function(o){return{value:o.value,text:o.text.trim()};});
    if(type==='file')f.accept=el.getAttribute('accept')||'';
    return f;
  }
  function scan(c){return Array.prototype.slice.call(c.querySelectorAll('input,textarea,select')).map(proc).filter(Boolean);}
  var forms=[];
  var fels=Array.prototype.slice.call(document.querySelectorAll('form'));
  if(fels.length>0)fels.forEach(function(form,i){try{var fields=scan(form);if(!fields.length)return;var name=form.getAttribute('aria-label')||form.getAttribute('name')||form.getAttribute('id')||('Form '+(i+1));forms.push({id:'form-'+i,name:name,fields:fields});}catch(e){}});
  if(!forms.length){try{var loose=Array.prototype.slice.call(document.querySelectorAll('input,textarea,select')).filter(function(el){return !el.closest('form');}).map(proc).filter(Boolean);if(loose.length)forms.push({id:'loose',name:'Application Fields',fields:loose});}catch(e){}}
  return forms;
})()""")
                _res_q.put({"ok": True, "forms": _forms or []})
            elif _t == "check_google_login":
                try:
                    _cookies = _ctx.cookies(urls=["https://accounts.google.com", "https://google.com"])
                    _session_names = {"SID", "SAPISID", "__Secure-3PSID", "SSID"}
                    _has_session = any(c["name"] in _session_names for c in _cookies)
                    _email = None
                    if _has_session:
                        _vp = _ctx.new_page()
                        try:
                            _vp.goto("https://accounts.google.com/", wait_until="domcontentloaded", timeout=12000)
                            _vp.wait_for_timeout(1500)
                            _email = _vp.evaluate("""() => {
                                const byData = document.querySelector('[data-email]');
                                if (byData) return byData.getAttribute('data-email');
                                const byAria = document.querySelector('[aria-label*="@"]');
                                if (byAria) return byAria.getAttribute('aria-label');
                                const chip = document.querySelector('.gb_lb, .gb_kb');
                                if (chip) return chip.textContent.trim();
                                return null;
                            }""")
                        except Exception:
                            pass
                        finally:
                            try: _vp.close()
                            except Exception: pass
                    _res_q.put({"ok": True, "logged_in": _has_session, "email": _email})
                except Exception as _ce:
                    _res_q.put({"ok": False, "error": str(_ce)})
            else:
                _res_q.put({"ok": False, "error": "unknown command"})
        except Exception as _e:
            err = str(_e)
            _res_q.put({"ok": False, "error": err})
            # Exit if the browser or context was closed during a command.
            if any(k in err.lower() for k in ("closed", "disconnected", "target")):
                break
'''


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

    # ── Application browser ───────────────────────────────────────────────────
    def browser_open(self, url: str) -> dict:
        """Launch a headed Playwright Chromium browser at the given URL.
        Saves the current app window state, tiles both windows side-by-side,
        and returns {ok, port} for the local HTTP control API."""
        import subprocess, sys, json, time

        self._browser_close_internal()

        # Register atexit once so a clean app exit also kills the browser.
        if not getattr(self, "_browser_atexit_registered", False):
            import atexit
            atexit.register(self._browser_close_internal)
            self._browser_atexit_registered = True

        # ── Window tiling ─────────────────────────────────────────────────────
        bounds_args: list[str] = []
        if webview.windows:
            try:
                self._saved_window_state = self._get_window_state()
                app_b, brw_b = self._get_tile_layout()
                if app_b and brw_b:
                    win = webview.windows[0]
                    # macOS fullscreen lives in its own Space — exit it first.
                    if self._saved_window_state.get("fullscreen") and sys.platform == "darwin":
                        win.toggle_fullscreen()
                        time.sleep(0.8)   # wait for exit-fullscreen animation
                    # On macOS, pywebview's resize()/move() dispatch to the main
                    # thread asynchronously — they return before the frame actually
                    # moves.  Use objc.callOnMainThread so the frame is set
                    # synchronously before Chrome reads the layout half a second later.
                    if sys.platform == "darwin":
                        try:
                            from AppKit import NSApplication, NSRect, NSPoint, NSSize
                            import objc as _objc
                            _nsw = NSApplication.sharedApplication().mainWindow()
                            if _nsw:
                                _sf = (_nsw.screen() or
                                       __import__('AppKit').NSScreen.mainScreen()).frame()
                                _ns_y = _sf.size.height - app_b["y"] - app_b["h"]
                                _frame = NSRect(NSPoint(app_b["x"], _ns_y),
                                                NSSize(app_b["w"], app_b["h"]))
                                _objc.callOnMainThread(
                                    _nsw.setFrame_display_animate_, _frame, True, False
                                )
                            else:
                                win.resize(app_b["w"], app_b["h"])
                                win.move(app_b["x"], app_b["y"])
                        except Exception:
                            win.resize(app_b["w"], app_b["h"])
                            win.move(app_b["x"], app_b["y"])
                    else:
                        win.resize(app_b["w"], app_b["h"])
                        win.move(app_b["x"], app_b["y"])
                    time.sleep(0.15)  # let compositor settle before Chrome positions itself
                    bounds_args = [
                        str(brw_b["x"]), str(brw_b["y"]),
                        str(brw_b["w"]), str(brw_b["h"]),
                    ]
            except Exception:
                self._saved_window_state = None
                bounds_args = []

        # ── Launch subprocess ─────────────────────────────────────────────────
        try:
            profile_dir = str(self._workspace / "browser-profile")
            proc = subprocess.Popen(
                [sys.executable, "-c", _BROWSER_AGENT, url, *bounds_args, profile_dir],
                stdin=subprocess.PIPE,   # agent watches stdin; EOF → agent exits
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
            )
            line = proc.stdout.readline()
            if not line:
                err = proc.stderr.read(500)
                self._restore_window_state()
                return {"ok": False, "error": err or "browser agent failed to start"}
            info = json.loads(line.strip())
            if not info.get("ok"):
                proc.terminate()
                self._restore_window_state()
                return info
            self._browser_proc = proc
            self._browser_port = info["port"]
            # Watch for subprocess exit on a background thread so we can
            # restore the app window and notify JS the instant it dies —
            # rather than waiting up to 5 s for the health poll to fire.
            import threading
            threading.Thread(
                target=self._watch_browser_exit,
                args=(proc,),
                daemon=True,
            ).start()
            return {"ok": True, "port": info["port"]}
        except Exception as e:
            self._restore_window_state()
            return {"ok": False, "error": str(e)}

    def browser_close(self) -> dict:
        return self._browser_close_internal()

    def browser_detect_fields(self) -> dict:
        """Scan the active page for HTML form fields and return structured data."""
        port = getattr(self, "_browser_port", None)
        if not port:
            return {"ok": False, "error": "Browser not open"}
        try:
            import urllib.request, json as _json
            req = urllib.request.Request(
                f"http://127.0.0.1:{port}/detect-fields",
                method="POST",
                data=b"{}",
                headers={"Content-Type": "application/json"},
            )
            with urllib.request.urlopen(req, timeout=15) as resp:
                return _json.loads(resp.read().decode())
        except Exception as e:
            return {"ok": False, "error": str(e)}

    def browser_get_profile_status(self) -> dict:
        """Return whether a validated browser profile exists, plus account metadata."""
        meta_path = self._workspace / "browser-profile" / "profile-meta.json"
        if meta_path.exists():
            try:
                import json as _json
                meta = _json.loads(meta_path.read_text(encoding="utf-8"))
                return {
                    "exists": True,
                    "google_email": meta.get("google_email"),
                    "setup_date": meta.get("setup_date"),
                }
            except Exception:
                pass
        return {"exists": False}

    def browser_setup_profile(self) -> dict:
        """Open a headed Chromium with persistent context at Google sign-in."""
        (self._workspace / "browser-profile").mkdir(parents=True, exist_ok=True)
        return self.browser_open("https://accounts.google.com")

    def browser_check_google_login(self) -> dict:
        """Verify Google session cookies exist and extract the account email.
        On success, writes profile-meta.json so the profile is marked as set up."""
        import json as _json, urllib.request
        port = getattr(self, "_browser_port", None)
        if not port:
            return {"ok": False, "error": "Browser not open"}
        try:
            req = urllib.request.Request(
                f"http://127.0.0.1:{port}/check-google-login",
                method="POST",
                data=b"{}",
                headers={"Content-Type": "application/json"},
            )
            with urllib.request.urlopen(req, timeout=20) as resp:
                result = _json.loads(resp.read().decode())
            if result.get("ok") and result.get("logged_in"):
                import datetime
                meta = {
                    "google_email": result.get("email"),
                    "setup_date": datetime.date.today().isoformat(),
                }
                meta_path = self._workspace / "browser-profile" / "profile-meta.json"
                meta_path.write_text(_json.dumps(meta, indent=2), encoding="utf-8")
            return result
        except Exception as e:
            return {"ok": False, "error": str(e)}

    def browser_reset_profile(self) -> dict:
        """Delete all browser profile data (saved sessions, cookies, logins)."""
        import shutil
        self._browser_close_internal()
        profile_dir = self._workspace / "browser-profile"
        if profile_dir.exists():
            try:
                shutil.rmtree(profile_dir)
            except Exception as e:
                return {"ok": False, "error": str(e)}
        profile_dir.mkdir(parents=True, exist_ok=True)
        (profile_dir / ".gitkeep").touch()
        return {"ok": True}

    def _browser_close_internal(self) -> dict:
        proc = getattr(self, "_browser_proc", None)
        port = getattr(self, "_browser_port", None)
        if proc:
            if port:
                try:
                    import urllib.request
                    req = urllib.request.Request(
                        f"http://127.0.0.1:{port}/stop",
                        method="POST",
                        data=b"{}",
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
            self._browser_proc = None
            self._browser_port = None
            self._restore_window_state()
        return {"ok": True}

    def _watch_browser_exit(self, proc) -> None:
        """Block until the browser agent subprocess exits.
        Restores the app window immediately and pushes a JS event so the UI
        updates without waiting for the health-poll interval."""
        try:
            proc.wait()
        except Exception:
            pass
        # Restore window immediately on this thread — fast, no JS roundtrip.
        self._restore_window_state()
        # Notify JS so the UI re-renders (shows "Open Application" button, etc.).
        try:
            if webview.windows:
                webview.windows[0].evaluate_js(
                    'typeof _onBrowserProcessDied === "function" && _onBrowserProcessDied()'
                )
        except Exception:
            pass

    # ── Window state helpers ──────────────────────────────────────────────────

    def _get_tile_layout(self):
        """Return (app_bounds, browser_bounds) dicts for side-by-side tiling.
        Bounds use top-left origin, consistent with pywebview move/resize and
        CDP Browser.setWindowBounds. Returns (None, None) on failure."""
        import sys
        try:
            if sys.platform == "darwin":
                return self._tile_layout_macos()
            elif sys.platform == "win32":
                return self._tile_layout_windows()
            else:
                return self._tile_layout_linux()
        except Exception:
            return None, None

    def _tile_layout_macos(self):
        from AppKit import NSScreen
        sf = NSScreen.mainScreen().frame()         # full screen (bottom-left origin)
        vf = NSScreen.mainScreen().visibleFrame()  # excludes menu-bar + dock
        total_h = sf.size.height
        # Convert bottom-left NSScreen origin → top-left (pywebview + CDP convention)
        x  = int(vf.origin.x)
        y  = int(total_h - vf.origin.y - vf.size.height)
        w  = int(vf.size.width)
        h  = int(vf.size.height)
        hw = w // 2
        # Browser gets the exact remaining pixels so the windows are contiguous
        # without any rounding gap or single-pixel overlap.
        return ({"x": x,       "y": y, "w": hw,     "h": h},
                {"x": x + hw,  "y": y, "w": w - hw, "h": h})

    def _tile_layout_windows(self):
        import ctypes, ctypes.wintypes
        # SPI_GETWORKAREA (0x30) — screen area excluding the taskbar
        rect = ctypes.wintypes.RECT()
        ctypes.windll.user32.SystemParametersInfoW(0x30, 0, ctypes.byref(rect), 0)
        x, y = rect.left, rect.top
        w, h = rect.right - rect.left, rect.bottom - rect.top
        hw   = w // 2
        return ({"x": x,      "y": y, "w": hw, "h": h},
                {"x": x + hw, "y": y, "w": hw, "h": h})

    def _tile_layout_linux(self):
        import subprocess, re
        out = subprocess.check_output(["xrandr", "--current"], timeout=3).decode()
        m   = re.search(r"current (\d+) x (\d+)", out)
        if not m:
            return None, None
        w, h = int(m.group(1)), int(m.group(2))
        hw   = w // 2
        return ({"x": 0,  "y": 0, "w": hw, "h": h},
                {"x": hw, "y": 0, "w": hw, "h": h})

    def _get_window_state(self) -> dict:
        """Capture app window geometry + fullscreen flag for later restoration."""
        import sys
        state: dict = {"fullscreen": False, "maximized": False,
                       "x": None, "y": None, "w": None, "h": None}
        if not webview.windows:
            return state
        try:
            if sys.platform == "darwin":
                from AppKit import NSApplication, NSScreen
                ns_win = NSApplication.sharedApplication().mainWindow()
                if ns_win:
                    f       = ns_win.frame()
                    total_h = NSScreen.mainScreen().frame().size.height
                    state["fullscreen"] = bool(ns_win.styleMask() & (1 << 14))
                    state["x"] = int(f.origin.x)
                    # Convert NSWindow bottom-left y → top-left y
                    state["y"] = int(total_h - f.origin.y - f.size.height)
                    state["w"] = int(f.size.width)
                    state["h"] = int(f.size.height)
            elif sys.platform == "win32":
                import ctypes, ctypes.wintypes
                hwnd = self._get_win32_hwnd()
                if hwnd:
                    rect = ctypes.wintypes.RECT()
                    ctypes.windll.user32.GetWindowRect(hwnd, ctypes.byref(rect))
                    state["x"]         = rect.left
                    state["y"]         = rect.top
                    state["w"]         = rect.right  - rect.left
                    state["h"]         = rect.bottom - rect.top
                    state["maximized"] = bool(ctypes.windll.user32.IsZoomed(hwnd))
        except Exception:
            pass
        return state

    def _get_win32_hwnd(self):
        """Find the main app HWND by matching window title (Windows only)."""
        import ctypes, ctypes.wintypes
        title  = getattr(self._config, "app_title", "")
        result = [None]

        @ctypes.WINFUNCTYPE(ctypes.c_bool, ctypes.wintypes.HWND, ctypes.wintypes.LPARAM)
        def _cb(hwnd, _):
            if ctypes.windll.user32.IsWindowVisible(hwnd):
                n = ctypes.windll.user32.GetWindowTextLengthW(hwnd)
                if n:
                    buf = ctypes.create_unicode_buffer(n + 1)
                    ctypes.windll.user32.GetWindowTextW(hwnd, buf, n + 1)
                    if title in buf.value:
                        result[0] = hwnd
                        return False
            return True

        ctypes.windll.user32.EnumWindows(_cb, 0)
        return result[0]

    def _restore_window_state(self) -> None:
        """Restore app window to the state captured before tiling."""
        import sys, time
        saved = getattr(self, "_saved_window_state", None)
        if not saved or not webview.windows:
            return
        self._saved_window_state = None
        try:
            win = webview.windows[0]
            if saved.get("fullscreen"):
                time.sleep(0.2)          # let any close animations settle
                win.toggle_fullscreen()
            elif saved.get("maximized"):
                win.maximize()
            elif saved.get("w") and saved.get("h"):
                # Same synchronous-frame trick used in browser_open — ensures
                # the window is at its restored position before the user sees it.
                if sys.platform == "darwin":
                    try:
                        from AppKit import NSApplication, NSRect, NSPoint, NSSize, NSScreen
                        import objc as _objc
                        _nsw = NSApplication.sharedApplication().mainWindow()
                        if (_nsw and saved.get("x") is not None
                                 and saved.get("y") is not None):
                            _sf = (_nsw.screen() or NSScreen.mainScreen()).frame()
                            _ns_y = _sf.size.height - saved["y"] - saved["h"]
                            _frame = NSRect(NSPoint(saved["x"], _ns_y),
                                            NSSize(saved["w"], saved["h"]))
                            _objc.callOnMainThread(
                                _nsw.setFrame_display_animate_, _frame, True, False
                            )
                        else:
                            win.resize(saved["w"], saved["h"])
                            win.move(saved["x"], saved["y"])
                    except Exception:
                        win.resize(saved["w"], saved["h"])
                        if saved.get("x") is not None and saved.get("y") is not None:
                            win.move(saved["x"], saved["y"])
                else:
                    win.resize(saved["w"], saved["h"])
                    if saved.get("x") is not None and saved.get("y") is not None:
                        win.move(saved["x"], saved["y"])
            # Bring our own app window to front so the restored window surfaces
            # immediately without the user having to click it.
            if sys.platform == "darwin":
                try:
                    from AppKit import NSApplication
                    NSApplication.sharedApplication().activateIgnoringOtherApps_(True)
                except Exception:
                    pass
        except Exception:
            pass

    # ── Export ───────────────────────────────────────────────────────────────
    def export_resume_pdf(self, html: str, filename: str) -> dict:
        """Render resume HTML to a PDF via Playwright/Chromium and save to ~/Downloads.
        Runs Playwright in a subprocess to avoid greenlet/pywebview thread conflicts."""
        import pathlib
        import subprocess
        import sys
        import tempfile
        import os

        downloads = pathlib.Path.home() / "Downloads"
        downloads.mkdir(exist_ok=True)
        path = downloads / filename

        stem, suffix = path.stem, path.suffix
        i = 1
        while path.exists():
            path = downloads / f"{stem}_{i}{suffix}"
            i += 1

        # Write HTML to a temp file so the subprocess can read it cleanly
        try:
            tmp = tempfile.NamedTemporaryFile(
                suffix=".html", delete=False, mode="w", encoding="utf-8"
            )
            tmp.write(html)
            tmp.close()
        except Exception as e:
            return {"ok": False, "error": f"failed to write temp file: {e}"}

        # Playwright runs in a subprocess — avoids conflicts with pywebview's
        # internal thread/greenlet model that cause sync_playwright() to hang.
        script = (
            "from playwright.sync_api import sync_playwright\n"
            f"html_path = {repr(tmp.name)}\n"
            f"pdf_path  = {repr(str(path))}\n"
            "with sync_playwright() as pw:\n"
            "    b = pw.chromium.launch()\n"
            "    p = b.new_page()\n"
            "    p.set_content(open(html_path, encoding='utf-8').read(), wait_until='domcontentloaded')\n"
            "    p.pdf(path=pdf_path, format='Letter',\n"
            "          margin={'top':'0','right':'0','bottom':'0','left':'0'},\n"
            "          print_background=True)\n"
            "    b.close()\n"
        )

        try:
            result = subprocess.run(
                [sys.executable, "-c", script],
                capture_output=True,
                text=True,
                timeout=60,
            )
        except subprocess.TimeoutExpired:
            return {"ok": False, "error": "PDF generation timed out (>60s)"}
        except Exception as e:
            return {"ok": False, "error": str(e)}
        finally:
            try:
                os.unlink(tmp.name)
            except OSError:
                pass

        if result.returncode != 0:
            err = (result.stderr or result.stdout or "unknown error").strip()
            return {"ok": False, "error": err[-400:]}

        return {"ok": True, "path": str(path), "filename": path.name}
