#!/usr/bin/env python3
"""Start Document Manager (installed by install.py).

Runs the app on http://127.0.0.1:<port>, opens it in the browser, and shows a
small window with "Open" and "Stop" buttons. Closing the window stops the app.
"""
import json
import os
import secrets
import sys
import threading
import time
import urllib.request
import webbrowser
from pathlib import Path

HERE = Path(__file__).resolve().parent
CONFIG = json.loads((HERE / "config.json").read_text(encoding="utf-8")) if (HERE / "config.json").exists() else {}
PORT = int(CONFIG.get("port", 8765))
URL = f"http://127.0.0.1:{PORT}/"
DATA = Path(CONFIG.get("data_dir", HERE / "data"))
BACKEND = HERE / "app" / "backend"


def configure_environment() -> None:
    DATA.mkdir(parents=True, exist_ok=True)
    key_file = DATA / ".secret_key"
    if not key_file.exists():
        key_file.write_text(secrets.token_urlsafe(50), encoding="utf-8")
    os.environ.update({
        "DM_DATA_DIR": str(DATA),
        "DM_FRONTEND_DIST": str(HERE / "app" / "frontend" / "dist"),
        "DM_DEBUG": "0",
        "DM_SECRET_KEY": key_file.read_text(encoding="utf-8").strip(),
        "DM_ALLOWED_HOSTS": "127.0.0.1,localhost",
        "DJANGO_SETTINGS_MODULE": "config.settings",
        # Environments the app creates stay in the program folder (not in a synced Documents folder).
        "DM_ENVS_DIR": str(HERE / "envs"),
        # Mirror and proxy chosen in the installer: the app starts with them (Settings can change them).
        "DM_PACKAGE_DEFAULTS": json.dumps(CONFIG.get("package_sources") or {}),
    })
    # Tools installed by the installer (pandoc, portable git, TinyTeX) come first.
    extra = [d for d in CONFIG.get("path_dirs", []) if Path(d).exists()]
    # The environment's own folders, so Jupyter kernels find the right Python. A conda
    # environment started without "conda activate" also needs its DLL folders on Windows.
    prefix = Path(sys.prefix)
    extra.append(str(Path(sys.executable).parent))
    if sys.platform == "win32" and (prefix / "conda-meta").is_dir():
        extra += [str(prefix / d) for d in ("Library/mingw-w64/bin", "Library/usr/bin", "Library/bin", "Scripts")
                  if (prefix / d).is_dir()]
    os.environ["PATH"] = os.pathsep.join(extra + [os.environ.get("PATH", "")])
    sys.path.insert(0, str(BACKEND))
    os.chdir(BACKEND)


def already_running() -> bool:
    try:
        with urllib.request.urlopen(URL + "api/settings/", timeout=1) as resp:
            return resp.status == 200
    except OSError:
        return False


def setup_django():
    import django
    from django.core.management import call_command

    django.setup()
    call_command("migrate", interactive=False, verbosity=0)


def serve():
    from django.core.wsgi import get_wsgi_application
    from waitress import create_server

    # One process with threads: notebook kernels live in this process.
    server = create_server(get_wsgi_application(), host="127.0.0.1", port=PORT, threads=8,
                           channel_timeout=3600, max_request_body_size=200 * 1024 * 1024)
    thread = threading.Thread(target=server.run, daemon=True)
    thread.start()
    return server


def wait_and_open():
    for _ in range(100):
        if already_running():
            webbrowser.open(URL)
            return
        time.sleep(0.1)


def window(server):
    import tkinter as tk
    from tkinter import ttk

    root = tk.Tk()
    root.title("Document Manager")
    root.resizable(False, False)
    frame = ttk.Frame(root, padding=16)
    frame.pack()
    ttk.Label(frame, text="Document Manager is running", font=("TkDefaultFont", 13, "bold")).pack(anchor="w")
    ttk.Label(frame, text=URL).pack(anchor="w", pady=(4, 12))
    row = ttk.Frame(frame)
    row.pack(fill="x")

    def stop():
        server.close()
        root.destroy()

    ttk.Button(row, text="Open in browser", command=lambda: webbrowser.open(URL)).pack(side="left")
    ttk.Button(row, text="Stop", command=stop).pack(side="left", padx=8)
    ttk.Label(frame, text="Closing this window stops the app.", foreground="#667180").pack(anchor="w", pady=(12, 0))
    root.protocol("WM_DELETE_WINDOW", stop)
    root.mainloop()


def main() -> int:
    configure_environment()
    if "--migrate-only" in sys.argv:
        setup_django()
        print("Database ready.")
        return 0
    if already_running():
        webbrowser.open(URL)
        return 0
    setup_django()
    server = serve()
    if "--no-browser" not in sys.argv:
        threading.Thread(target=wait_and_open, daemon=True).start()
    headless = "--no-window" in sys.argv
    if not headless:
        try:
            window(server)
            return 0
        except Exception as exc:  # no Tk or no display: fall back to the terminal
            print(f"(No window available: {exc})")
    print(f"Document Manager is running at {URL} — press Ctrl+C to stop.")
    try:
        while True:
            time.sleep(3600)
    except KeyboardInterrupt:
        server.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
