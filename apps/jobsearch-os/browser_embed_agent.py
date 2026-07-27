"""
Embedded application-browser subprocess.

Launched by ``bridge.JobSearchBridge.browser_embed_open`` (see bridge.py). Runs
a headless Chromium (real Chrome binary via ``channel="chrome"``) against the
same persistent profile used by the existing "Set up Browser Account" flow, so
a job site sees the same logged-in session either way.

Instead of showing a second OS window (what the older side-by-side
``browser_open`` flow in AgentOS Core does), this streams the page as an MJPEG
multipart HTTP stream — a plain ``<img>`` tag can render that natively with no
client-side decoding — and accepts mouse/keyboard/scroll events posted back as
JSON, replaying them into the page over the Chrome DevTools Protocol (CDP).

Architecture mirrors AgentOS Core's ``browser_agent.py`` on purpose: a single
main thread owns the Playwright sync API and drains a command queue (the sync
API is not thread-safe across threads), while HTTP handler threads only ever
enqueue work and wait on plain-Python primitives for results. Event callbacks
registered with Playwright (``page.on(...)``, ``cdp.on(...)``) fire on
Playwright's own internal thread, so they only ever touch thread-safe
buffers/flags — never call back into the sync API directly. That constraint is
exactly why frame-acking and file-chooser fulfillment happen on the main loop's
poll cycle below, not inside the callbacks that discover them.

Usage: ``python browser_embed_agent.py <url> <profile_dir> [width] [height]``
Prints one JSON line ``{"ok": true, "port": <n>}`` on stdout once ready, then
serves until stdin hits EOF (parent process exited) or ``/stop`` is called.
"""
from __future__ import annotations

import base64
import json
import os
import queue
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

from playwright.sync_api import sync_playwright

_cmd_q: "queue.Queue[dict]" = queue.Queue()
_res_q: "queue.Queue[dict]" = queue.Queue()

# Frame delivery: latest JPEG bytes + a condition so /stream handlers can block
# until the next frame instead of polling.
_frame_lock = threading.Lock()
_frame_cond = threading.Condition(_frame_lock)
_latest_frame: bytes | None = None
_frame_seq = 0

# Frames arrive on Playwright's internal thread via cdp.on(...); stash them
# here so the main loop can ack + publish them from the thread that owns the
# sync API.
_pending_frames: "queue.Queue[dict]" = queue.Queue()

# File-chooser bridging: the callback (Playwright's thread) stores the
# FileChooser object; the main loop calls .set_files() once the frontend has
# posted paths chosen via the native OS dialog.
_chooser_lock = threading.Lock()
_pending_chooser = None  # type: ignore[assignment]

_page_closed = threading.Event()


def _drain_frames(cdp):
    """Ack every queued screencast frame and publish the newest one.

    Must run on the main thread (the one that owns the Playwright sync API) —
    ``cdp.send`` is not safe to call from the frames' own arrival thread.
    """
    global _latest_frame, _frame_seq
    newest = None
    while True:
        try:
            newest = _pending_frames.get_nowait()
        except queue.Empty:
            break
        try:
            cdp.send("Page.screencastFrameAck", {"sessionId": newest["sessionId"]})
        except Exception:
            pass
    if newest is not None:
        try:
            data = base64.b64decode(newest["data"])
        except Exception:
            return
        with _frame_cond:
            _latest_frame = data
            _frame_seq += 1
            _frame_cond.notify_all()


def _start_screencast(cdp, width: int, height: int):
    cdp.send("Page.startScreencast", {
        "format": "jpeg", "quality": 78,
        "maxWidth": width, "maxHeight": height,
    })


# ── CDP key table for the small set of control keys we hand-map. Printable
# characters go through Input.insertText instead (handles unicode/paste for
# free), so this only needs to cover navigation/editing keys forms rely on.
_KEY_TABLE = {
    "Backspace": dict(key="Backspace", code="Backspace", windowsVirtualKeyCode=8),
    "Tab":       dict(key="Tab", code="Tab", windowsVirtualKeyCode=9),
    "Enter":     dict(key="Enter", code="Enter", windowsVirtualKeyCode=13),
    "Escape":    dict(key="Escape", code="Escape", windowsVirtualKeyCode=27),
    "Delete":    dict(key="Delete", code="Delete", windowsVirtualKeyCode=46),
    "ArrowLeft": dict(key="ArrowLeft", code="ArrowLeft", windowsVirtualKeyCode=37),
    "ArrowUp":   dict(key="ArrowUp", code="ArrowUp", windowsVirtualKeyCode=38),
    "ArrowRight": dict(key="ArrowRight", code="ArrowRight", windowsVirtualKeyCode=39),
    "ArrowDown": dict(key="ArrowDown", code="ArrowDown", windowsVirtualKeyCode=40),
}


class _Handler(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    # ── small helpers ────────────────────────────────────────────────────────
    def _json(self, payload, status=200):
        body = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _body(self) -> dict:
        n = int(self.headers.get("Content-Length", 0))
        return json.loads(self.rfile.read(n)) if n else {}

    def _dispatch(self, cmd, timeout=20):
        _cmd_q.put(cmd)
        try:
            return _res_q.get(timeout=timeout)
        except queue.Empty:
            return {"ok": False, "error": "timeout"}

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Content-Length", "0")
        self.end_headers()

    # ── GET ──────────────────────────────────────────────────────────────────
    def do_GET(self):
        path = urlparse(self.path).path
        if path == "/ping":
            self._json({"ok": True})
        elif path == "/status":
            self._json(self._dispatch({"t": "status"}, timeout=5))
        elif path == "/file-chooser":
            with _chooser_lock:
                pending = _pending_chooser is not None
            self._json({"ok": True, "pending": pending})
        elif path == "/stream":
            self._stream_sse()
        else:
            self._json({"ok": False, "error": "not found"}, 404)

    def _stream_sse(self):
        # Frames go out as Server-Sent Events (base64 JPEG per event), matching
        # the SSE transport already used elsewhere in this app (OpenCode's own
        # chat stream). Tried multipart/x-mixed-replace on an <img> first —
        # modern Chromium (and WebView2, which is the same engine) no longer
        # renders that for <img src>, confirmed by a standalone repro: correct
        # headers and bytes over the wire, but naturalWidth stays 0 forever.
        self.send_response(200)
        self.send_header("Cache-Control", "no-cache, private")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Content-Type", "text/event-stream")
        self.end_headers()
        last_seq = -1
        try:
            while True:
                with _frame_cond:
                    _frame_cond.wait_for(lambda: _frame_seq != last_seq, timeout=5)
                    frame = _latest_frame
                    last_seq = _frame_seq
                if frame is None:
                    continue
                b64 = base64.b64encode(frame).decode()
                self.wfile.write(f"data: {b64}\n\n".encode())
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            pass
        except Exception:
            pass

    # ── POST ─────────────────────────────────────────────────────────────────
    def do_POST(self):
        path = urlparse(self.path).path
        body = self._body()
        if path == "/status":
            # The bridge polls status via POST (its generic request helper);
            # /ping and browser UI code that fetch() directly still use GET.
            self._json(self._dispatch({"t": "status"}, timeout=5))
        elif path == "/navigate":
            self._json(self._dispatch({"t": "navigate", "url": body.get("url", "")}, timeout=25))
        elif path == "/back":
            self._json(self._dispatch({"t": "back"}, timeout=15))
        elif path == "/forward":
            self._json(self._dispatch({"t": "forward"}, timeout=15))
        elif path == "/reload":
            self._json(self._dispatch({"t": "reload"}, timeout=15))
        elif path == "/set-viewport":
            self._json(self._dispatch({
                "t": "set_viewport",
                "width": int(body.get("width", 1280)),
                "height": int(body.get("height", 900)),
            }, timeout=10))
        elif path == "/input":
            # Fire-and-forget: input needs to feel instant, not wait on a
            # round trip. The main loop drains these as fast as it drains
            # anything else in _cmd_q.
            _cmd_q.put({"t": "input", **body})
            self._json({"ok": True})
        elif path == "/set-files":
            self._json(self._dispatch({"t": "set_files", "paths": body.get("paths", [])}, timeout=15))
        elif path == "/stop":
            _cmd_q.put({"t": "stop"})
            self._json({"ok": True})
        else:
            self._json({"ok": False, "error": "not found"}, 404)


def _watch_stdin():
    """Exit when the parent process dies (stdin EOF) — prevents orphan Chromium."""
    try:
        sys.stdin.read()
    except Exception:
        pass
    os._exit(0)


def main():
    threading.Thread(target=_watch_stdin, daemon=True).start()

    start_url = sys.argv[1] if len(sys.argv) > 1 else "about:blank"
    profile_dir = sys.argv[2] if len(sys.argv) > 2 else ""
    width = int(sys.argv[3]) if len(sys.argv) > 3 else 1280
    height = int(sys.argv[4]) if len(sys.argv) > 4 else 900

    if profile_dir:
        import pathlib
        lock = pathlib.Path(profile_dir) / "SingletonLock"
        try:
            if lock.exists() or lock.is_symlink():
                lock.unlink()
        except Exception:
            pass
        pathlib.Path(profile_dir).mkdir(parents=True, exist_ok=True)

    with sync_playwright() as pw:
        ctx = pw.chromium.launch_persistent_context(
            profile_dir,
            headless=True,
            channel="chrome",
            viewport={"width": width, "height": height},
            ignore_default_args=["--enable-automation"],
            args=[
                "--disable-blink-features=AutomationControlled",
                "--no-first-run",
                "--no-default-browser-check",
            ],
        )
        page = ctx.pages[0] if ctx.pages else ctx.new_page()

        def _on_close(_p):
            _page_closed.set()

        def _on_filechooser(fc):
            global _pending_chooser
            with _chooser_lock:
                _pending_chooser = fc

        def _on_frame(params):
            _pending_frames.put(params)

        page.on("close", _on_close)
        page.on("filechooser", _on_filechooser)

        cdp = ctx.new_cdp_session(page)
        cdp.on("Page.screencastFrame", _on_frame)

        try:
            page.goto(start_url, wait_until="domcontentloaded", timeout=20000)
        except Exception:
            pass
        _start_screencast(cdp, width, height)

        server = ThreadingHTTPServer(("127.0.0.1", 0), _Handler)
        server.daemon_threads = True
        threading.Thread(target=server.serve_forever, daemon=True).start()
        print(json.dumps({"ok": True, "port": server.server_address[1]}), flush=True)

        while True:
            try:
                cmd = _cmd_q.get(timeout=0.02)
            except queue.Empty:
                _drain_frames(cdp)
                if _page_closed.is_set():
                    _page_closed.clear()
                    try:
                        page = ctx.new_page()
                        page.on("close", _on_close)
                        page.on("filechooser", _on_filechooser)
                        cdp = ctx.new_cdp_session(page)
                        cdp.on("Page.screencastFrame", _on_frame)
                        _start_screencast(cdp, width, height)
                    except Exception:
                        break
                continue

            if cmd.get("t") == "stop":
                break

            try:
                t = cmd["t"]
                if t == "status":
                    _res_q.put({"ok": True, "url": page.url, "title": page.title()})
                elif t == "navigate":
                    page.goto(cmd["url"], wait_until="domcontentloaded", timeout=20000)
                    _res_q.put({"ok": True, "url": page.url})
                elif t == "back":
                    page.go_back(wait_until="domcontentloaded", timeout=15000)
                    _res_q.put({"ok": True, "url": page.url})
                elif t == "forward":
                    page.go_forward(wait_until="domcontentloaded", timeout=15000)
                    _res_q.put({"ok": True, "url": page.url})
                elif t == "reload":
                    page.reload(wait_until="domcontentloaded", timeout=15000)
                    _res_q.put({"ok": True, "url": page.url})
                elif t == "set_viewport":
                    width, height = cmd["width"], cmd["height"]
                    page.set_viewport_size({"width": width, "height": height})
                    _start_screencast(cdp, width, height)
                    _res_q.put({"ok": True})
                elif t == "set_files":
                    global _pending_chooser
                    with _chooser_lock:
                        chooser = _pending_chooser
                        _pending_chooser = None
                    if chooser is None:
                        _res_q.put({"ok": False, "error": "No file field is waiting for a file."})
                    else:
                        chooser.set_files(cmd.get("paths") or [])
                        _res_q.put({"ok": True})
                elif t == "input":
                    _handle_input(cdp, cmd)
                    # /input doesn't wait on _res_q (fire-and-forget above).
                else:
                    _res_q.put({"ok": False, "error": "unknown command"})
            except Exception as e:
                err = str(e)
                if cmd.get("t") != "input":
                    _res_q.put({"ok": False, "error": err})
                if any(k in err.lower() for k in ("closed", "disconnected", "target")):
                    break

        try:
            ctx.close()
        except Exception:
            pass


def _handle_input(cdp, cmd):
    kind = cmd.get("kind")
    if kind == "mouse_move":
        cdp.send("Input.dispatchMouseEvent", {
            "type": "mouseMoved", "x": cmd["x"], "y": cmd["y"],
        })
    elif kind == "mouse_down":
        cdp.send("Input.dispatchMouseEvent", {
            "type": "mousePressed", "x": cmd["x"], "y": cmd["y"],
            "button": cmd.get("button", "left"), "clickCount": 1,
        })
    elif kind == "mouse_up":
        cdp.send("Input.dispatchMouseEvent", {
            "type": "mouseReleased", "x": cmd["x"], "y": cmd["y"],
            "button": cmd.get("button", "left"), "clickCount": 1,
        })
    elif kind == "wheel":
        cdp.send("Input.dispatchMouseEvent", {
            "type": "mouseWheel", "x": cmd["x"], "y": cmd["y"],
            "deltaX": cmd.get("deltaX", 0), "deltaY": cmd.get("deltaY", 0),
        })
    elif kind == "text":
        # Printable runs (including paste, IME, unicode) — one call, no key
        # table needed.
        cdp.send("Input.insertText", {"text": cmd.get("text", "")})
    elif kind == "key":
        name = cmd.get("name")
        spec = _KEY_TABLE.get(name)
        if not spec:
            return
        modifiers = cmd.get("modifiers", 0)
        cdp.send("Input.dispatchKeyEvent", {"type": "rawKeyDown", "modifiers": modifiers, **spec})
        cdp.send("Input.dispatchKeyEvent", {"type": "keyUp", "modifiers": modifiers, **spec})


if __name__ == "__main__":
    main()
