#!/usr/bin/env python3
"""Document Manager installer (Windows, macOS, Linux).

Run with Python 3.10 or newer:

    python install.py            # graphical installer (Tkinter)
    python install.py --cli      # same steps in the terminal
    python install.py --uninstall

It installs everything else the app needs into its own folder, without
touching system settings and without administrator rights:

* a private Python environment with the app's packages (Django, Jupyter…)
* Pandoc (preview and export), if a recent one is not already installed
* Git for Windows (portable MinGit) on Windows, if git is missing
* optionally TinyTeX with the LaTeX packages for PDF export (incl. Persian)
* optionally data-science packages for notebooks (numpy, pandas, matplotlib)
* the web interface (built with a temporary copy of Node.js if needed)
* a desktop shortcut / app-menu entry that starts the app
"""
from __future__ import annotations

import argparse
import json
import os
import platform
import queue
import shutil
import ssl
import subprocess
import sys
import tarfile
import tempfile
import threading
import traceback
import urllib.request
import zipfile
from dataclasses import asdict, dataclass, field
from pathlib import Path

APP_NAME = "Document Manager"
SOURCE = Path(__file__).resolve().parent.parent  # the repository / release folder
MIN_PYTHON = (3, 10)
DEFAULT_PORT = 8765

PANDOC_VERSION = "3.6.4"
NODE_VERSION = "22.12.0"
MINGIT_VERSION = "2.47.1"
TINYTEX_VERSION = "2026.02"

# Where tlmgr fetches packages: the live CTAN mirror while the bundled TeX Live
# year is current, afterwards that year's frozen archive.
TEX_HISTORIC = [
    "https://ftp.math.utah.edu/pub/tex/historic/systems/texlive/{year}/tlnet-final",
    "https://ftp.tu-chemnitz.de/pub/tug/historic/systems/texlive/{year}/tlnet-final",
    "https://mirrors.tuna.tsinghua.edu.cn/tex-historic-archive/systems/texlive/{year}/tlnet-final",
]

# LaTeX packages needed on top of TinyTeX for pandoc's template, callouts and Persian.
TEX_PACKAGES = [
    "babel", "babel-english", "hyphen-persian", "pdfcol", "tikzfill", "fontspec", "unicode-math", "lm", "lm-math",
    "luaotfload", "luatexbase", "lualatex-math", "selnolig", "tcolorbox", "pgf", "environ",
    "trimspaces", "etoolbox", "xcolor", "geometry", "hyperref", "bookmark", "xurl", "upquote",
    "microtype", "parskip", "booktabs", "fancyvrb", "framed", "listings", "caption", "float",
    "iftex", "zref", "needspace", "footnotehyper", "amsmath", "amsfonts", "tools",
]

SYSTEM = platform.system()  # "Windows", "Darwin", "Linux"
MACHINE = platform.machine().lower()
ARM = MACHINE in ("arm64", "aarch64")


# ---------------------------------------------------------------- locations

def default_install_dir() -> Path:
    home = Path.home()
    if SYSTEM == "Windows":
        return Path(os.environ.get("LOCALAPPDATA", home / "AppData" / "Local")) / "DocumentManager"
    if SYSTEM == "Darwin":
        return home / "Library" / "Application Support" / "DocumentManager"
    return Path(os.environ.get("XDG_DATA_HOME", home / ".local" / "share")) / "document-manager"


def default_data_dir() -> Path:
    docs = Path.home() / "Documents"
    return (docs if docs.exists() else Path.home()) / "Document Manager"


def venv_python(install: Path) -> Path:
    if SYSTEM == "Windows":
        return install / "venv" / "Scripts" / "python.exe"
    return install / "venv" / "bin" / "python"


def venv_pythonw(install: Path) -> Path:
    """Windows: pythonw.exe starts without a console window."""
    if SYSTEM == "Windows":
        return install / "venv" / "Scripts" / "pythonw.exe"
    return venv_python(install)


# ---------------------------------------------------------------- options

@dataclass
class Options:
    install_dir: str = field(default_factory=lambda: str(default_install_dir()))
    data_dir: str = field(default_factory=lambda: str(default_data_dir()))
    pdf: bool = True
    science: bool = True
    shortcut: bool = True
    port: int = DEFAULT_PORT


class InstallError(Exception):
    pass


# ---------------------------------------------------------------- helpers

class Installer:
    """Runs the installation steps, reporting through ``log`` and ``progress``."""

    def __init__(self, opts: Options, log=print, progress=lambda fraction, label: None):
        self.opts = opts
        self.install = Path(opts.install_dir).expanduser().resolve()
        self.data = Path(opts.data_dir).expanduser().resolve()
        self.tools = self.install / "tools"
        self.log = log
        self.progress = progress
        self.path_dirs: list[str] = []
        self.ssl_context: ssl.SSLContext | None = None

    # -- running commands
    def run(self, cmd: list[str], cwd: Path | None = None, env: dict | None = None, quiet=False) -> str:
        self.log("$ " + " ".join(str(c) for c in cmd))
        full_env = {**os.environ, **(env or {})}
        if self.path_dirs:
            full_env["PATH"] = os.pathsep.join(self.path_dirs + [full_env.get("PATH", "")])
        proc = subprocess.Popen([str(c) for c in cmd], cwd=cwd, env=full_env, stdout=subprocess.PIPE,
                                stderr=subprocess.STDOUT, text=True, encoding="utf-8", errors="replace",
                                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        output = []
        assert proc.stdout
        for line in proc.stdout:
            output.append(line)
            if not quiet:
                self.log("  " + line.rstrip())
        if proc.wait() != 0:
            tail = "".join(output[-15:])
            raise InstallError(f"Command failed: {' '.join(str(c) for c in cmd)}\n{tail}")
        return "".join(output)

    def download(self, url: str, dest: Path) -> Path:
        self.log(f"Downloading {url}")
        dest.parent.mkdir(parents=True, exist_ok=True)
        req = urllib.request.Request(url, headers={"User-Agent": "DocumentManager-Installer"})
        try:
            resp = urllib.request.urlopen(req, timeout=60, context=self.ssl_context)
        except ssl.SSLError as exc:
            raise InstallError(f"Secure connection failed ({exc}). On macOS, run “Install Certificates.command” "
                               "from your Python folder, then try again.") from exc
        except OSError as exc:
            raise InstallError(f"Download failed: {url}\n{exc}") from exc
        total = int(resp.headers.get("Content-Length") or 0)
        done = 0
        last = -1
        with open(dest, "wb") as out:
            while chunk := resp.read(1 << 16):
                out.write(chunk)
                done += len(chunk)
                if total:
                    pct = int(done * 100 / total)
                    if pct // 10 != last // 10:
                        self.log(f"  {pct}% of {total // (1 << 20)} MB")
                    last = pct
        return dest

    def extract(self, archive: Path, dest: Path) -> None:
        self.log(f"Extracting {archive.name}")
        dest.mkdir(parents=True, exist_ok=True)
        name = archive.name
        if name.endswith(".zip"):
            with zipfile.ZipFile(archive) as z:
                z.extractall(dest)
        else:
            with tarfile.open(archive) as t:
                if sys.version_info >= (3, 12):
                    t.extractall(dest, filter="tar")
                else:
                    t.extractall(dest)
        if SYSTEM != "Windows":
            # zipfile does not keep the executable bit.
            for p in dest.rglob("*"):
                if p.is_file() and (p.parent.name == "bin" or p.suffix == ""):
                    try:
                        p.chmod(p.stat().st_mode | 0o111)
                    except OSError:
                        pass

    @staticmethod
    def version_of(cmd: str, flag="--version") -> str | None:
        exe = shutil.which(cmd)
        if not exe:
            return None
        try:
            out = subprocess.run([exe, flag], capture_output=True, text=True, timeout=30).stdout
            return out.splitlines()[0] if out else ""
        except (OSError, subprocess.SubprocessError):
            return None

    # -- steps
    def steps(self):
        steps = [
            ("Checking this computer", self.check),
            ("Copying the application", self.copy_app),
            ("Creating a private Python environment", self.make_venv),
            ("Installing Python packages", self.pip_install),
            ("Setting up Git", self.setup_git),
            ("Setting up Pandoc", self.setup_pandoc),
        ]
        if self.opts.pdf:
            steps.append(("Setting up LaTeX for PDF export (this is the largest download)", self.setup_tex))
        steps += [
            ("Building the user interface", self.build_frontend),
            ("Writing the configuration", self.write_config),
            ("Preparing the database", self.migrate),
        ]
        if self.opts.shortcut:
            steps.append(("Creating shortcuts", self.make_shortcuts))
        return steps

    def run_all(self):
        steps = self.steps()
        for i, (label, fn) in enumerate(steps):
            self.progress(i / len(steps), label)
            self.log(f"\n== {label}")
            fn()
        self.progress(1.0, "Done")
        self.log(f"\n{APP_NAME} is installed in {self.install}")
        self.log(f"Your projects will be stored in {self.data / 'projects'}")

    def check(self):
        if sys.version_info < MIN_PYTHON:
            raise InstallError(f"Python {MIN_PYTHON[0]}.{MIN_PYTHON[1]} or newer is required "
                               f"(this is {platform.python_version()}). Get it from https://www.python.org/downloads/")
        if not (SOURCE / "backend" / "manage.py").exists():
            raise InstallError(f"Run this installer from inside the {APP_NAME} folder (backend/ not found next to it).")
        self.log(f"Python {platform.python_version()} on {SYSTEM} {MACHINE}")
        self.log(f"Installing from {SOURCE}")
        self.install.mkdir(parents=True, exist_ok=True)
        self.data.mkdir(parents=True, exist_ok=True)
        free = shutil.disk_usage(self.install).free // (1 << 20)
        need = 1500 if self.opts.pdf else 700
        self.log(f"Free disk space: {free} MB (about {need} MB needed)")
        if free < need:
            raise InstallError(f"Not enough disk space: {free} MB free, about {need} MB needed.")

    def copy_app(self):
        app = self.install / "app"
        backend = app / "backend"
        if backend.exists():
            shutil.rmtree(backend)
        shutil.copytree(SOURCE / "backend", backend,
                        ignore=shutil.ignore_patterns("__pycache__", "*.pyc", "staticfiles", ".venv", "venv"))
        shutil.copy2(SOURCE / "installer" / "launch.py", self.install / "launch.py")
        shutil.copy2(Path(__file__), self.install / "install.py")
        # Keep the source path so the installed copy can repair/uninstall later.
        (self.install / "source.txt").write_text(str(SOURCE), encoding="utf-8")

    def make_venv(self):
        py = venv_python(self.install)
        if not py.exists():
            try:
                import venv  # noqa: F401
            except ImportError as exc:
                raise InstallError("Python's venv module is missing. On Debian/Ubuntu: sudo apt install python3-venv") from exc
            self.run([sys.executable, "-m", "venv", self.install / "venv"])
        self.run([py, "-m", "pip", "install", "--upgrade", "pip", "certifi"], quiet=True)
        # Use certifi's certificates for downloads (python.org's macOS Python has none by default),
        # unless the environment already points at a CA bundle (corporate proxies).
        cafile = os.environ.get("SSL_CERT_FILE") or os.environ.get("REQUESTS_CA_BUNDLE")
        if not cafile:
            cafile = subprocess.run([str(py), "-c", "import certifi; print(certifi.where())"],
                                    capture_output=True, text=True).stdout.strip() or None
        self.ssl_context = ssl.create_default_context(cafile=cafile) if cafile else None

    def pip_install(self):
        py = venv_python(self.install)
        reqs = ["-r", self.install / "app" / "backend" / "requirements.txt"]
        if self.opts.science:
            reqs += ["-r", self.install / "app" / "backend" / "requirements-science.txt"]
        self.run([py, "-m", "pip", "install", "--disable-pip-version-check", *reqs])

    def setup_git(self):
        found = self.version_of("git")
        if found:
            self.log(f"Found {found}")
            return
        if SYSTEM == "Windows":
            url = (f"https://github.com/git-for-windows/git/releases/download/v{MINGIT_VERSION}.windows.1/"
                   f"MinGit-{MINGIT_VERSION}-{'arm64' if ARM else '64-bit'}.zip")
            archive = self.download(url, self.tools / "downloads" / "mingit.zip")
            self.extract(archive, self.tools / "git")
            self.path_dirs.append(str(self.tools / "git" / "cmd"))
            self.log("Installed portable Git.")
        elif SYSTEM == "Darwin":
            subprocess.run(["xcode-select", "--install"], capture_output=True)
            raise InstallError("Git is not installed. macOS is now offering to install the Command Line Tools "
                               "(which include git). Finish that, then run this installer again.")
        else:
            raise InstallError("Git is not installed. Install it with your package manager, e.g.\n"
                               "  sudo apt install git     (Debian/Ubuntu)\n"
                               "  sudo dnf install git     (Fedora)\nthen run this installer again.")

    def setup_pandoc(self):
        found = self.version_of("pandoc")
        try:
            have = tuple(int(x) for x in found.split()[-1].split(".")[:2]) if found else (0, 0)
        except ValueError:
            have = (0, 0)
        # Pandoc < 3.6 mishandles Persian in LaTeX/PDF (babel loads the language twice).
        if have >= (3, 6):
            self.log(f"Found {found}")
            return
        if found:
            self.log(f"Found {found}, which is too old for Persian PDFs; installing a private copy of {PANDOC_VERSION}.")
        base = f"https://github.com/jgm/pandoc/releases/download/{PANDOC_VERSION}/pandoc-{PANDOC_VERSION}"
        if SYSTEM == "Windows":
            url = f"{base}-windows-x86_64.zip"
        elif SYSTEM == "Darwin":
            url = f"{base}-{'arm64' if ARM else 'x86_64'}-macOS.zip"
        else:
            url = f"{base}-linux-{'arm64' if ARM else 'amd64'}.tar.gz"
        archive = self.download(url, self.tools / "downloads" / url.rsplit("/", 1)[-1])
        target = self.tools / "pandoc"
        if target.exists():
            shutil.rmtree(target)
        self.extract(archive, target)
        exe = next(target.rglob("pandoc.exe" if SYSTEM == "Windows" else "pandoc"))
        self.path_dirs.append(str(exe.parent))
        self.log(f"Installed Pandoc {PANDOC_VERSION}.")

    def setup_tex(self):
        """Optional: failures are reported but do not stop the installation."""
        before = list(self.path_dirs)
        try:
            self._setup_tex()
        except InstallError as exc:
            self.path_dirs = before  # don't expose a LaTeX without the packages it needs
            self.log(f"WARNING: PDF export could not be set up: {exc}")
            self.log("Everything else will work. Run the installer again later to retry PDF support.")

    def _setup_tex(self):
        if shutil.which("lualatex"):
            self.log("Found an existing LaTeX installation (lualatex). Using it.")
            return
        base = f"https://github.com/rstudio/tinytex-releases/releases/download/v{TINYTEX_VERSION}/TinyTeX-1-v{TINYTEX_VERSION}"
        url = base + {"Windows": ".zip", "Darwin": ".tgz"}.get(SYSTEM, ".tar.gz")
        archive = self.download(url, self.tools / "downloads" / url.rsplit("/", 1)[-1])
        target = self.tools / "tex"
        if target.exists():
            shutil.rmtree(target)
        self.extract(archive, target)
        tlmgr = next((p for p in target.rglob("tlmgr.bat" if SYSTEM == "Windows" else "tlmgr") if p.parent.parent.name == "bin"), None)
        if not tlmgr:
            raise InstallError("TinyTeX was downloaded but tlmgr was not found.")
        self.path_dirs.append(str(tlmgr.parent))
        version = self.run([tlmgr, "--version"], quiet=True)
        year = next((w for w in version.split() if w.isdigit() and len(w) == 4), None)
        repositories = ["ctan"] + ([u.format(year=year) for u in TEX_HISTORIC] if year else [])
        self.log("Installing LaTeX packages (Persian, callout boxes, fonts)…")
        errors = []
        for repo in repositories:
            try:
                self.run([tlmgr, "option", "repository", repo], quiet=True)
                self.run([tlmgr, "install", *TEX_PACKAGES])
                break
            except InstallError as exc:
                errors.append(f"{repo}: {str(exc).splitlines()[-1]}")
                self.log(f"Package source {repo} did not work; trying the next one.")
        else:
            raise InstallError("Could not download LaTeX packages.\n" + "\n".join(errors))

    def build_frontend(self):
        dist_target = self.install / "app" / "frontend" / "dist"
        prebuilt = SOURCE / "frontend" / "dist" / "index.html"
        if dist_target.exists():
            shutil.rmtree(dist_target)
        if prebuilt.exists() and os.environ.get("DM_REBUILD_UI") != "1":
            self.log("Using the prebuilt interface.")
            shutil.copytree(prebuilt.parent, dist_target)
            return
        node = shutil.which("node")
        npm = shutil.which("npm")
        version = self.version_of("node") or ""
        major = int(version.lstrip("v").split(".")[0]) if version.lstrip("v")[:1].isdigit() else 0
        temp_node = None
        if not (node and npm and major >= 18):
            self.log("Node.js is not installed; downloading a temporary copy to build the interface.")
            arch = "arm64" if ARM else "x64"
            if SYSTEM == "Windows":
                name = f"node-v{NODE_VERSION}-win-{arch}.zip"
            elif SYSTEM == "Darwin":
                name = f"node-v{NODE_VERSION}-darwin-{arch}.tar.gz"
            else:
                name = f"node-v{NODE_VERSION}-linux-{arch}.tar.xz"
            archive = self.download(f"https://nodejs.org/dist/v{NODE_VERSION}/{name}", self.tools / "downloads" / name)
            temp_node = self.tools / "node"
            self.extract(archive, temp_node)
            home = next(temp_node.iterdir())
            bin_dir = home if SYSTEM == "Windows" else home / "bin"
            self.path_dirs.insert(0, str(bin_dir))
            npm = str(bin_dir / ("npm.cmd" if SYSTEM == "Windows" else "npm"))
        build = self.install / "build-frontend"
        if build.exists():
            shutil.rmtree(build)
        shutil.copytree(SOURCE / "frontend", build, ignore=shutil.ignore_patterns("node_modules", "dist"))
        self.run([npm, "ci", "--no-audit", "--no-fund"], cwd=build)
        self.run([npm, "run", "build"], cwd=build)
        shutil.copytree(build / "dist", dist_target)
        shutil.rmtree(build, ignore_errors=True)
        if temp_node:
            self.path_dirs.pop(0)
            shutil.rmtree(temp_node, ignore_errors=True)

    def write_config(self):
        config = {
            "version": 1,
            "data_dir": str(self.data),
            "port": self.opts.port,
            "path_dirs": self.path_dirs,
            "options": asdict(self.opts),
        }
        (self.install / "config.json").write_text(json.dumps(config, indent=2), encoding="utf-8")
        shutil.rmtree(self.tools / "downloads", ignore_errors=True)

    def migrate(self):
        self.run([venv_python(self.install), self.install / "launch.py", "--migrate-only"])

    def make_shortcuts(self):
        made = create_shortcuts(self.install)
        for path in made:
            self.log(f"Created {path}")


# ---------------------------------------------------------------- shortcuts

def shortcut_paths() -> list[Path]:
    home = Path.home()
    if SYSTEM == "Windows":
        start = Path(os.environ.get("APPDATA", home)) / "Microsoft" / "Windows" / "Start Menu" / "Programs"
        return [desktop_dir() / f"{APP_NAME}.lnk", start / f"{APP_NAME}.lnk"]
    if SYSTEM == "Darwin":
        return [home / "Applications" / f"{APP_NAME}.app"]
    apps = Path(os.environ.get("XDG_DATA_HOME", home / ".local" / "share")) / "applications"
    return [apps / "document-manager.desktop", desktop_dir() / "document-manager.desktop"]


def desktop_dir() -> Path:
    if SYSTEM == "Windows":
        try:
            out = subprocess.run(["powershell", "-NoProfile", "-Command", "[Environment]::GetFolderPath('Desktop')"],
                                 capture_output=True, text=True, timeout=30,
                                 creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0)).stdout.strip()
            if out:
                return Path(out)
        except (OSError, subprocess.SubprocessError):
            pass
    if SYSTEM == "Linux":
        try:
            out = subprocess.run(["xdg-user-dir", "DESKTOP"], capture_output=True, text=True, timeout=10).stdout.strip()
            if out:
                return Path(out)
        except (OSError, subprocess.SubprocessError):
            pass
    return Path.home() / "Desktop"


def create_shortcuts(install: Path) -> list[Path]:
    made = []
    launcher = install / "launch.py"
    if SYSTEM == "Windows":
        target = venv_pythonw(install)
        for lnk in shortcut_paths():
            lnk.parent.mkdir(parents=True, exist_ok=True)
            ps = (
                "$s = (New-Object -ComObject WScript.Shell).CreateShortcut($env:DM_LNK);"
                "$s.TargetPath = $env:DM_TARGET; $s.Arguments = '\"' + $env:DM_LAUNCHER + '\"';"
                "$s.WorkingDirectory = $env:DM_WORKDIR; $s.Description = 'Document Manager'; $s.Save()"
            )
            env = {**os.environ, "DM_LNK": str(lnk), "DM_TARGET": str(target), "DM_LAUNCHER": str(launcher),
                   "DM_WORKDIR": str(install)}
            subprocess.run(["powershell", "-NoProfile", "-Command", ps], env=env, check=True,
                           creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
            made.append(lnk)
    elif SYSTEM == "Darwin":
        app = shortcut_paths()[0]
        macos = app / "Contents" / "MacOS"
        macos.mkdir(parents=True, exist_ok=True)
        script = macos / "DocumentManager"
        script.write_text(f'#!/bin/sh\nexec "{venv_python(install)}" "{launcher}"\n', encoding="utf-8")
        script.chmod(0o755)
        (app / "Contents" / "Info.plist").write_text(
            '<?xml version="1.0" encoding="UTF-8"?>\n'
            '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n'
            '<plist version="1.0"><dict>\n'
            f"<key>CFBundleName</key><string>{APP_NAME}</string>\n"
            "<key>CFBundleIdentifier</key><string>local.document-manager</string>\n"
            "<key>CFBundleExecutable</key><string>DocumentManager</string>\n"
            "<key>CFBundlePackageType</key><string>APPL</string>\n"
            "<key>CFBundleShortVersionString</key><string>1.0</string>\n"
            "</dict></plist>\n", encoding="utf-8")
        made.append(app)
    else:
        entry = (
            "[Desktop Entry]\nType=Application\n"
            f"Name={APP_NAME}\nName[fa]=مدیر اسناد\n"
            "Comment=Write books and research with git version control\n"
            f'Exec="{venv_python(install)}" "{launcher}"\n'
            "Icon=accessories-text-editor\nTerminal=false\nCategories=Office;\n"
        )
        for path in shortcut_paths():
            if path.parent.name != "applications" and not path.parent.exists():
                continue  # no Desktop folder
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(entry, encoding="utf-8")
            path.chmod(0o755)
            subprocess.run(["gio", "set", str(path), "metadata::trusted", "true"], capture_output=True)
            made.append(path)
    return made


def uninstall(install: Path, log=print) -> None:
    """Remove the program and its shortcuts. Projects and the database are kept."""
    config = install / "config.json"
    data = None
    if config.exists():
        data = json.loads(config.read_text(encoding="utf-8")).get("data_dir")
    for path in shortcut_paths():
        if path.is_dir():
            shutil.rmtree(path, ignore_errors=True)
            log(f"Removed {path}")
        elif path.exists():
            path.unlink()
            log(f"Removed {path}")
    if install.exists():
        shutil.rmtree(install, ignore_errors=True)
        log(f"Removed {install}")
    if data:
        log(f"Your projects were kept in {data}")


# ---------------------------------------------------------------- graphical installer

def pandoc_status() -> str:
    found = Installer.version_of("pandoc")
    if not found:
        return "will be downloaded"
    try:
        if tuple(int(x) for x in found.split()[-1].split(".")[:2]) < (3, 6):
            return f"{found} — too old; a newer private copy will be installed"
    except ValueError:
        pass
    return found

def run_gui(opts: Options) -> int:
    import tkinter as tk
    from tkinter import filedialog, messagebox, ttk

    root = tk.Tk()
    root.title(f"{APP_NAME} — Setup")
    root.geometry("720x560")
    root.minsize(600, 480)
    try:
        ttk.Style().theme_use("clam" if SYSTEM == "Linux" else ttk.Style().theme_use())
    except tk.TclError:
        pass

    container = ttk.Frame(root, padding=20)
    container.pack(fill="both", expand=True)
    pages: dict[str, ttk.Frame] = {}

    def show(name: str):
        for frame in pages.values():
            frame.pack_forget()
        pages[name].pack(fill="both", expand=True)

    # --- welcome
    welcome = ttk.Frame(container)
    pages["welcome"] = welcome
    ttk.Label(welcome, text=f"Welcome to {APP_NAME}", font=("TkDefaultFont", 18, "bold")).pack(anchor="w")
    ttk.Label(welcome, wraplength=640, justify="left", text=(
        "Write books and research in Markdown, LaTeX, rich text and Jupyter notebooks — in Persian, English or "
        "both — with full version history and collaboration through git.\n\n"
        "This installer sets up everything the app needs in its own folder. Nothing else on your computer is "
        "changed and no administrator rights are needed. An internet connection is required."
    )).pack(anchor="w", pady=(10, 16))
    checks = ttk.LabelFrame(welcome, text="This computer", padding=10)
    checks.pack(fill="x")
    rows = [
        ("Python", f"{platform.python_version()} ✓" if sys.version_info >= MIN_PYTHON else f"{platform.python_version()} — 3.10+ required ✗"),
        ("Git", Installer.version_of("git") or ("will be downloaded" if SYSTEM == "Windows" else "missing — needed")),
        ("Pandoc", pandoc_status()),
        ("LaTeX (PDF)", "found" if shutil.which("lualatex") else "can be downloaded (optional)"),
        ("Node.js", "not needed" if (SOURCE / "frontend" / "dist" / "index.html").exists()
         else (Installer.version_of("node") or "a temporary copy will be downloaded")),
    ]
    for i, (name, value) in enumerate(rows):
        ttk.Label(checks, text=name + ":", width=14).grid(row=i, column=0, sticky="w")
        ttk.Label(checks, text=value).grid(row=i, column=1, sticky="w")
    nav = ttk.Frame(welcome)
    nav.pack(side="bottom", fill="x")
    existing = Path(opts.install_dir) / "config.json"

    def do_uninstall():
        if messagebox.askyesno("Uninstall", f"Remove {APP_NAME} from {opts.install_dir}?\n\nYour projects are kept."):
            lines = []
            uninstall(Path(opts.install_dir), log=lines.append)
            messagebox.showinfo("Uninstall", "\n".join(lines) or "Nothing to remove.")
            root.destroy()

    if existing.exists():
        ttk.Button(nav, text="Uninstall", command=do_uninstall).pack(side="left")
    ttk.Button(nav, text="Next →", command=lambda: show("options")).pack(side="right")
    ttk.Button(nav, text="Cancel", command=root.destroy).pack(side="right", padx=8)

    # --- options
    options = ttk.Frame(container)
    pages["options"] = options
    ttk.Label(options, text="Options", font=("TkDefaultFont", 16, "bold")).pack(anchor="w")
    install_var = tk.StringVar(value=opts.install_dir)
    data_var = tk.StringVar(value=opts.data_dir)
    pdf_var = tk.BooleanVar(value=opts.pdf)
    sci_var = tk.BooleanVar(value=opts.science)
    sc_var = tk.BooleanVar(value=opts.shortcut)

    def folder_row(label, var, hint):
        frame = ttk.Frame(options)
        frame.pack(fill="x", pady=(12, 0))
        ttk.Label(frame, text=label).pack(anchor="w")
        row = ttk.Frame(frame)
        row.pack(fill="x")
        ttk.Entry(row, textvariable=var).pack(side="left", fill="x", expand=True)
        ttk.Button(row, text="Browse…", command=lambda: var.set(filedialog.askdirectory(initialdir=var.get()) or var.get())).pack(side="left", padx=(6, 0))
        ttk.Label(frame, text=hint, foreground="#667180", wraplength=640).pack(anchor="w")

    folder_row("Program folder", install_var, "Where the app and its tools are installed.")
    folder_row("Data folder", data_var, "Where your projects (git repositories) are stored. Uninstalling never deletes this.")
    box = ttk.LabelFrame(options, text="Components", padding=10)
    box.pack(fill="x", pady=16)
    ttk.Checkbutton(box, text="PDF export, including Persian typesetting (TinyTeX, about 400 MB)", variable=pdf_var).pack(anchor="w")
    ttk.Checkbutton(box, text="Data-science packages for notebooks: numpy, pandas, matplotlib, scipy (about 250 MB)", variable=sci_var).pack(anchor="w")
    ttk.Checkbutton(box, text="Desktop shortcut and app-menu entry", variable=sc_var).pack(anchor="w")
    nav2 = ttk.Frame(options)
    nav2.pack(side="bottom", fill="x")

    # --- progress
    prog = ttk.Frame(container)
    pages["progress"] = prog
    step_var = tk.StringVar(value="Starting…")
    ttk.Label(prog, text="Installing", font=("TkDefaultFont", 16, "bold")).pack(anchor="w")
    ttk.Label(prog, textvariable=step_var).pack(anchor="w", pady=(8, 4))
    bar = ttk.Progressbar(prog, mode="determinate", maximum=100)
    bar.pack(fill="x")
    log_box = tk.Text(prog, height=18, wrap="word", font=("TkFixedFont", 9))
    log_box.pack(fill="both", expand=True, pady=10)
    nav3 = ttk.Frame(prog)
    nav3.pack(side="bottom", fill="x")
    finish_btn = ttk.Button(nav3, text="Launch Document Manager", state="disabled")
    finish_btn.pack(side="right")
    close_btn = ttk.Button(nav3, text="Close", command=root.destroy, state="disabled")
    close_btn.pack(side="right", padx=8)

    events: queue.Queue = queue.Queue()
    result = {"code": 1}

    def start():
        o = Options(install_dir=install_var.get(), data_dir=data_var.get(), pdf=pdf_var.get(),
                    science=sci_var.get(), shortcut=sc_var.get(), port=opts.port)
        show("progress")
        inst = Installer(o, log=lambda m: events.put(("log", m)),
                         progress=lambda f, label: events.put(("progress", (f, label))))

        def worker():
            try:
                inst.run_all()
                events.put(("done", inst))
            except InstallError as exc:
                events.put(("error", str(exc)))
            except Exception:  # pragma: no cover - unexpected
                events.put(("error", traceback.format_exc()))

        threading.Thread(target=worker, daemon=True).start()

    def poll():
        try:
            while True:
                kind, payload = events.get_nowait()
                if kind == "log":
                    log_box.insert("end", payload + "\n")
                    log_box.see("end")
                elif kind == "progress":
                    fraction, label = payload
                    bar["value"] = fraction * 100
                    step_var.set(label)
                elif kind == "done":
                    inst = payload
                    step_var.set("Installation complete.")
                    result["code"] = 0
                    close_btn["state"] = "normal"

                    def launch():
                        subprocess.Popen([str(venv_pythonw(inst.install)), str(inst.install / "launch.py")],
                                         cwd=inst.install, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
                        root.destroy()

                    finish_btn.configure(state="normal", command=launch)
                elif kind == "error":
                    step_var.set("Installation failed — see the details below.")
                    log_box.insert("end", "\nERROR: " + payload + "\n")
                    log_box.see("end")
                    close_btn["state"] = "normal"
                    messagebox.showerror("Installation failed", payload[:1500])
        except queue.Empty:
            pass
        root.after(100, poll)

    ttk.Button(nav2, text="Install", command=start).pack(side="right")
    ttk.Button(nav2, text="← Back", command=lambda: show("welcome")).pack(side="right", padx=8)

    show("welcome")
    root.after(100, poll)
    root.mainloop()
    return result["code"]


# ---------------------------------------------------------------- command line

def run_cli(opts: Options, assume_yes: bool) -> int:
    print(f"{APP_NAME} installer\n")
    if not assume_yes:
        print(f"Program folder: {opts.install_dir}\nData folder:    {opts.data_dir}")
        print(f"PDF export (TinyTeX): {'yes' if opts.pdf else 'no'}   Data-science packages: {'yes' if opts.science else 'no'}")
        if input("Continue? [Y/n] ").strip().lower() not in ("", "y", "yes"):
            return 1

    def progress(fraction, label):
        print(f"[{int(fraction * 100):3d}%] {label}")

    try:
        Installer(opts, log=print, progress=progress).run_all()
    except InstallError as exc:
        print(f"\nInstallation failed:\n{exc}", file=sys.stderr)
        return 1
    launcher = Path(opts.install_dir) / "launch.py"
    print(f"\nStart the app from the shortcut, or run:\n  \"{venv_python(Path(opts.install_dir))}\" \"{launcher}\"")
    return 0


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=f"Install {APP_NAME}.")
    parser.add_argument("--cli", action="store_true", help="install in the terminal instead of a window")
    parser.add_argument("--yes", action="store_true", help="do not ask for confirmation (with --cli)")
    parser.add_argument("--install-dir", default=str(default_install_dir()))
    parser.add_argument("--data-dir", default=str(default_data_dir()))
    parser.add_argument("--no-pdf", action="store_true", help="skip LaTeX (PDF export)")
    parser.add_argument("--no-science", action="store_true", help="skip numpy/pandas/matplotlib/scipy")
    parser.add_argument("--no-shortcut", action="store_true")
    parser.add_argument("--port", type=int, default=DEFAULT_PORT)
    parser.add_argument("--uninstall", action="store_true", help="remove the program (keeps your projects)")
    args = parser.parse_args(argv)

    opts = Options(install_dir=args.install_dir, data_dir=args.data_dir, pdf=not args.no_pdf,
                   science=not args.no_science, shortcut=not args.no_shortcut, port=args.port)
    if args.uninstall:
        uninstall(Path(args.install_dir).expanduser())
        return 0
    if sys.version_info < MIN_PYTHON:
        print(f"Python {MIN_PYTHON[0]}.{MIN_PYTHON[1]}+ is required; this is {platform.python_version()}.\n"
              "Download it from https://www.python.org/downloads/", file=sys.stderr)
        return 1
    if not args.cli:
        try:
            import tkinter  # noqa: F401
            if SYSTEM == "Linux" and not (os.environ.get("DISPLAY") or os.environ.get("WAYLAND_DISPLAY")):
                raise RuntimeError("no display")
            return run_gui(opts)
        except (ImportError, RuntimeError) as exc:
            print(f"(Graphical installer unavailable: {exc}. Continuing in the terminal. "
                  "On Linux, `sudo apt install python3-tk` enables the window.)\n")
    return run_cli(opts, args.yes)


if __name__ == "__main__":
    sys.exit(main())
