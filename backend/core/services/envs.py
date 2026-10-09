"""Python environments: the app's own, conda environments and virtual environments.

Notebooks run their kernel in one of these. Environments are identified by
their prefix (folder); ``env_id`` is a short hash of it so it can be used in
URLs and as a Jupyter kernel name (``dm-env-<id>``).

conda is optional: it is found on PATH, from ``CONDA_EXE``, next to the app's
own environment, in the usual install folders, or at a path set in Settings.
"""
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path

from django.conf import settings

from . import jobs, packaging

WINDOWS = sys.platform == "win32"
KERNEL_PREFIX = "dm-env-"
NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")
PACKAGE_SPEC_RE = re.compile(r"^[A-Za-z0-9][^\s;|&<>`$]*$")


class EnvError(Exception):
    pass


# ---------------------------------------------------------------- paths & identity

def norm(path: str | Path) -> str:
    return os.path.normcase(str(Path(path).expanduser().resolve()))


def env_id(prefix: str | Path) -> str:
    return hashlib.sha1(norm(prefix).encode("utf-8")).hexdigest()[:12]


def kernel_name(prefix: str | Path) -> str:
    return KERNEL_PREFIX + env_id(prefix)


def python_in(prefix: Path) -> Path | None:
    candidates = ([prefix / "python.exe", prefix / "Scripts" / "python.exe"] if WINDOWS
                  else [prefix / "bin" / "python", prefix / "bin" / "python3"])
    return next((c for c in candidates if c.exists()), None)


def is_conda_prefix(prefix: Path) -> bool:
    return (prefix / "conda-meta").is_dir()


def prefix_of(path: str) -> Path:
    """Accept an environment folder or its python executable."""
    p = Path(path.strip().strip('"')).expanduser()
    if p.is_file() and p.name.lower().startswith("python"):
        p = p.parent.parent if p.parent.name.lower() in ("bin", "scripts") else p.parent
    p = p.resolve()
    if not p.is_dir() or not python_in(p):
        raise EnvError(f"No Python environment found at {path}. Choose the environment's folder "
                       "(the one containing bin/ or Scripts/, or conda-meta/).")
    return p


def activation_env(prefix: Path, extra: dict | None = None) -> dict:
    """Environment variables equivalent to activating ``prefix`` (enough to run its Python and tools)."""
    env = dict(os.environ)
    if WINDOWS:
        dirs = [prefix, prefix / "Library" / "mingw-w64" / "bin", prefix / "Library" / "usr" / "bin",
                prefix / "Library" / "bin", prefix / "Scripts", prefix / "bin"]
    else:
        dirs = [prefix / "bin"]
    env["PATH"] = os.pathsep.join([str(d) for d in dirs if d.exists()] + [env.get("PATH", "")])
    for var in ("PYTHONHOME", "PYTHONPATH", "VIRTUAL_ENV", "CONDA_PREFIX", "CONDA_DEFAULT_ENV"):
        env.pop(var, None)
    if is_conda_prefix(prefix):
        env["CONDA_PREFIX"] = str(prefix)
        env["CONDA_DEFAULT_ENV"] = str(prefix)
    else:
        env["VIRTUAL_ENV"] = str(prefix)
    env.update(extra or {})
    return env


# ---------------------------------------------------------------- conda

_conda_cache: dict = {"time": 0.0, "key": None, "value": None}
_conda_lock = threading.Lock()


def _conda_exe_in(base: Path) -> Path | None:
    names = (["Scripts/conda.exe", "condabin/conda.bat", "Library/bin/conda.bat"] if WINDOWS
             else ["bin/conda", "condabin/conda"])
    return next((base / n for n in names if (base / n).exists()), None)


def _conda_candidates() -> list[Path]:
    from core.models import AppSettings

    found: list[Path] = []
    custom = AppSettings.load().conda_path.strip()
    if custom:
        p = Path(custom).expanduser()
        found.append(p if p.is_file() else (_conda_exe_in(p) or p))
    for var in ("CONDA_EXE",):
        if os.environ.get(var):
            found.append(Path(os.environ[var]))
    for name in ("conda",):
        exe = shutil.which(name)
        if exe:
            found.append(Path(exe))
    # The app itself may run in a conda environment: <base>/envs/<name> or <base>.
    here = Path(sys.prefix)
    for base in (here, here.parent.parent if here.parent.name == "envs" else None):
        if base and (exe := _conda_exe_in(base)):
            found.append(exe)
    home = Path.home()
    names = ["miniforge3", "miniconda3", "anaconda3", "mambaforge", "miniconda", "anaconda"]
    roots = [home, home / "opt", Path("/opt"), Path("/usr/local")]
    if WINDOWS:
        roots += [Path(os.environ.get(v, "")) for v in ("LOCALAPPDATA", "ProgramData", "USERPROFILE") if os.environ.get(v)]
        roots += [Path(os.environ["LOCALAPPDATA"]) / "Programs"] if os.environ.get("LOCALAPPDATA") else []
    if sys.platform == "darwin":
        roots += [Path("/opt/homebrew/Caskroom/miniforge/base").parent, Path("/usr/local/Caskroom/miniforge/base").parent]
        names.append("base")
    for root in roots:
        for n in names:
            if exe := _conda_exe_in(root / n):
                found.append(exe)
    out, seen = [], set()
    for p in found:
        key = norm(p)
        if key not in seen and p.exists():
            seen.add(key)
            out.append(p)
    return out


def _run_json(cmd: list, timeout: int = 120, env: dict | None = None):
    try:
        proc = subprocess.run([str(c) for c in cmd], capture_output=True, text=True, encoding="utf-8",
                              errors="replace", timeout=timeout, env=env,
                              creationflags=subprocess.CREATE_NO_WINDOW if WINDOWS else 0)
    except (OSError, subprocess.SubprocessError) as exc:
        raise EnvError(f"Could not run {Path(str(cmd[0])).name}: {exc}") from exc
    if proc.returncode != 0:
        message = proc.stderr.strip() or proc.stdout.strip()
        try:
            message = json.loads(proc.stdout).get("message", message)
        except (ValueError, AttributeError):
            pass
        raise EnvError(f"{Path(str(cmd[0])).name} failed: {message[-1500:]}")
    try:
        return json.loads(proc.stdout)
    except ValueError as exc:
        raise EnvError(f"Unexpected output from {Path(str(cmd[0])).name}: {proc.stdout[:300]}") from exc


def conda_info(refresh: bool = False) -> dict | None:
    """``{"exe", "mamba", "root_prefix", "version", "envs": [...], "envs_dirs"}`` or None without conda."""
    with _conda_lock:
        candidates = _conda_candidates()
        key = tuple(norm(c) for c in candidates)
        if not refresh and _conda_cache["key"] == key and time.time() - _conda_cache["time"] < 60:
            return _conda_cache["value"]
        value = None
        for exe in candidates:
            try:
                info = _run_json([exe, "info", "--json"], timeout=60)
            except EnvError:
                continue
            root = Path(info.get("root_prefix") or info.get("conda_prefix") or exe.parent.parent)
            mamba = next((p for p in ([root / "Scripts" / "mamba.exe", root / "Library" / "bin" / "mamba.exe"] if WINDOWS
                                       else [root / "bin" / "mamba"]) if p.exists()), None)
            value = {"exe": str(exe), "mamba": str(mamba) if mamba else None, "root_prefix": str(root),
                     "version": info.get("conda_version", ""), "envs": info.get("envs", []),
                     "envs_dirs": info.get("envs_dirs", [])}
            break
        _conda_cache.update(time=time.time(), key=key, value=value)
        return value


def _conda_tool(prefer_mamba: bool = True) -> str:
    info = conda_info()
    if not info:
        raise EnvError("conda was not found. Install Anaconda, Miniconda or Miniforge, or set the path to conda in Settings.")
    if prefer_mamba and info.get("mamba") and packaging.get_config().get("use_mamba", True):
        return info["mamba"]
    return info["exe"]


# ---------------------------------------------------------------- environment list

_version_cache: dict[str, tuple[float, str]] = {}


def _python_version(prefix: Path, py: Path) -> str:
    cfg = prefix / "pyvenv.cfg"
    if cfg.exists():
        for line in cfg.read_text(encoding="utf-8", errors="replace").splitlines():
            k, _, v = line.partition("=")
            if k.strip() in ("version", "version_info"):
                return v.strip()
    meta = prefix / "conda-meta"
    if meta.is_dir():
        for f in meta.glob("python-[0-9]*.json"):
            return f.name.split("-")[1]
    try:
        out = subprocess.run([str(py), "-c", "import platform; print(platform.python_version())"],
                             capture_output=True, text=True, timeout=20,
                             creationflags=subprocess.CREATE_NO_WINDOW if WINDOWS else 0)
        return out.stdout.strip()
    except (OSError, subprocess.SubprocessError):
        return ""


def has_package(prefix: Path, module: str) -> bool:
    if WINDOWS:
        sites = [prefix / "Lib" / "site-packages"]
    else:
        sites = list((prefix / "lib").glob("python3*/site-packages"))
    return any((s / module).is_dir() for s in sites)


def describe(prefix: Path, kind: str | None = None, name: str | None = None, source: str = "",
             created_by_app: bool = False) -> dict | None:
    py = python_in(prefix)
    if not py:
        return None
    key = norm(prefix)
    stamp = py.stat().st_mtime
    cached = _version_cache.get(key)
    version = cached[1] if cached and cached[0] == stamp else _python_version(prefix, py)
    _version_cache[key] = (stamp, version)
    kind = kind or ("conda" if is_conda_prefix(prefix) else "venv")
    return {
        "id": env_id(prefix), "kernel": kernel_name(prefix), "name": name or prefix.name, "kind": kind,
        "path": str(prefix), "python": str(py), "python_version": version,
        "has_ipykernel": has_package(prefix, "ipykernel"), "source": source,
        "is_app": norm(prefix) == norm(sys.prefix), "created_by_app": created_by_app,
        "is_conda_base": False,
    }


def _scan_venvs(folder: Path) -> list[Path]:
    if not folder.is_dir():
        return []
    return [p for p in sorted(folder.iterdir()) if p.is_dir() and python_in(p)]


def list_envs(refresh: bool = False) -> list[dict]:
    from core.models import PythonEnv

    result: dict[str, dict] = {}

    def add(prefix: Path, **kw):
        key = norm(prefix)
        if key in result:
            if kw.get("created_by_app"):
                result[key]["created_by_app"] = True
            return
        info = describe(prefix, **kw)
        if info:
            result[key] = info

    app = Path(sys.prefix)
    add(app, name="Document Manager (this app)", source="app")
    rows = {norm(r.path): r for r in PythonEnv.objects.all()}
    conda = conda_info(refresh)
    if conda:
        root = norm(conda["root_prefix"])
        for p in conda["envs"]:
            prefix = Path(p)
            row = rows.get(norm(prefix))
            add(prefix, kind="conda", name="base" if norm(prefix) == root else prefix.name, source="conda",
                created_by_app=bool(row and row.created_by_app))
            if norm(prefix) in result and norm(prefix) == root:
                result[norm(prefix)]["is_conda_base"] = True
    for row in rows.values():
        add(Path(row.path), kind=row.kind, source="added", created_by_app=row.created_by_app)
    for folder, source in ((settings.ENVS_DIR, "app"), (Path(os.environ.get("WORKON_HOME", Path.home() / ".virtualenvs")), "found")):
        for prefix in _scan_venvs(folder):
            add(prefix, source=source, created_by_app=source == "app")
    envs = list(result.values())
    order = {"app": 0, "conda": 1}
    return sorted(envs, key=lambda e: (not e["is_app"], order.get(e["kind"], 2), e["name"].lower()))


def get_env(env_id_: str) -> dict:
    env = next((e for e in list_envs() if e["id"] == env_id_), None)
    if not env:
        raise EnvError("Environment not found. It may have been deleted; press Refresh.")
    return env


def env_by_kernel(name: str) -> dict | None:
    if not name or not name.startswith(KERNEL_PREFIX):
        return None
    return next((e for e in list_envs() if e["kernel"] == name), None)


def env_by_path(path: str) -> dict | None:
    if not path:
        return None
    key = norm(path)
    return next((e for e in list_envs() if norm(e["path"]) == key), None)


def app_env() -> dict:
    return describe(Path(sys.prefix), name="Document Manager (this app)", source="app")


def register(path: str) -> dict:
    from core.models import PythonEnv

    prefix = prefix_of(path)
    kind = "conda" if is_conda_prefix(prefix) else "venv"
    PythonEnv.objects.get_or_create(path=str(prefix), defaults={"kind": kind})
    return describe(prefix, kind=kind, source="added")


# ---------------------------------------------------------------- packages

def list_packages(env: dict) -> list[dict]:
    prefix = Path(env["path"])
    pip_items = []
    try:
        pip_items = _run_json([env["python"], "-m", "pip", "list", "--format=json", "--disable-pip-version-check"],
                              env=activation_env(prefix, packaging.command_env()))
    except EnvError:
        if env["kind"] != "conda":
            raise
    try:
        top = {i["name"].lower() for i in _run_json(
            [env["python"], "-m", "pip", "list", "--not-required", "--format=json", "--disable-pip-version-check"],
            env=activation_env(prefix, packaging.command_env()))}
    except EnvError:
        top = set()
    key = packaging._normalize_name  # conda and pip spell some names differently (prompt_toolkit / prompt-toolkit)
    top = {key(n) for n in top}
    packages = {key(i["name"]): {"name": i["name"], "version": i["version"], "manager": "pip",
                                 "top_level": key(i["name"]) in top} for i in pip_items}
    if env["kind"] == "conda" and conda_info():
        for item in _run_json([conda_info()["exe"], "list", "-p", prefix, "--json"]):
            if item.get("channel") == "pypi":
                continue  # installed by pip; already in the pip list
            name = item["name"]
            entry = packages.get(key(name), {"name": name, "top_level": key(name) in top})
            entry.update(version=item["version"], manager="conda", channel=item.get("channel", ""))
            packages[key(name)] = entry
    return sorted(packages.values(), key=lambda p: p["name"].lower())


def _check_specs(specs) -> list[str]:
    if isinstance(specs, str):
        specs = specs.split()
    specs = [s.strip() for s in specs or [] if s and s.strip()]
    if not specs:
        raise EnvError("Enter at least one package name.")
    for s in specs:
        if not PACKAGE_SPEC_RE.match(s):
            raise EnvError(f"“{s}” is not a valid package name or requirement.")
    return specs


def _busy(env: dict) -> None:
    job = jobs.running_for("env", env["id"])
    if job:
        raise EnvError(f"Wait for “{job.title}” to finish first.")


def package_job(env: dict, action: str, specs, manager: str = "pip") -> jobs.Job:
    """Install, upgrade or uninstall packages in ``env`` with pip or conda."""
    specs = _check_specs(specs)
    _busy(env)
    prefix = Path(env["path"])
    if manager == "conda":
        if env["kind"] != "conda":
            raise EnvError("conda can only install into conda environments; use pip here.")
        tool = _conda_tool()
        verb = {"install": "install", "upgrade": "update", "uninstall": "remove"}[action]
        cmd = [tool, verb, "-y", "-p", prefix, *specs]
        if action != "uninstall":
            cmd += packaging.conda_channel_args()
    elif manager == "pip":
        base = [env["python"], "-m", "pip"]
        if action == "uninstall":
            cmd = [*base, "uninstall", "-y", *specs]
        else:
            cmd = [*base, "install", *(["--upgrade"] if action == "upgrade" else []), *specs]
    else:
        raise EnvError("Unknown package manager.")
    titles = {"install": "Installing {p}", "upgrade": "Upgrading {p}", "uninstall": "Removing {p}"}
    title = titles[action].format(p=", ".join(specs)) + f" ({env['name']})"
    return jobs.start(jobs.Job(title, [cmd], env=activation_env(prefix, packaging.command_env()),
                               meta={"env": env["id"], "action": action}))


def search_conda(query: str) -> list[dict]:
    query = query.strip()
    if not re.fullmatch(r"[A-Za-z0-9*._-]+", query):
        raise EnvError("Enter a package name, for example numpy.")
    info = conda_info()
    if not info:
        raise EnvError("conda was not found.")
    pattern = query if "*" in query else f"*{query}*"
    try:
        data = _run_json([info["exe"], "search", "--json", *packaging.conda_channel_args(), pattern], timeout=300,
                         env={**os.environ, **packaging.proxy_env()})
    except EnvError as exc:
        if "PackagesNotFoundError" in str(exc) or "not available" in str(exc):
            return []
        raise
    if isinstance(data, dict) and "error" in data:
        return []
    results = []
    for name, builds in data.items():
        versions = list(dict.fromkeys(b["version"] for b in reversed(builds)))
        results.append({"name": name, "versions": versions[:30], "channel": builds[-1].get("channel", "")})
    results.sort(key=lambda r: (r["name"] != query, len(r["name"]), r["name"]))
    return results[:50]


# ---------------------------------------------------------------- create & delete

def _validate_name(name: str) -> str:
    name = (name or "").strip()
    if not NAME_RE.match(name):
        raise EnvError("Use letters, digits, dots, dashes or underscores for the name (no spaces).")
    return name


def _remember(path: Path, kind: str, created_by_app: bool):
    from core.models import PythonEnv

    PythonEnv.objects.update_or_create(path=str(path), defaults={"kind": kind, "created_by_app": created_by_app})
    _conda_cache["time"] = 0


def create_venv(name: str, base_python: str = "", packages=None, requirements: Path | None = None,
                on_created=None) -> jobs.Job:
    name = _validate_name(name)
    target = settings.ENVS_DIR / name
    if target.exists():
        raise EnvError(f"An environment named {name} already exists.")
    base = base_python.strip() or sys.executable
    if base_python:
        base_env = env_by_path(base_python) if not Path(base_python).is_file() else None
        base = base_env["python"] if base_env else base_python
    if not Path(base).exists():
        raise EnvError(f"Python not found: {base}")
    settings.ENVS_DIR.mkdir(parents=True, exist_ok=True)
    py = target / ("Scripts/python.exe" if WINDOWS else "bin/python")
    extra = _check_specs(packages) if packages else []
    steps = [[base, "-m", "venv", target], [py, "-m", "pip", "install", "ipykernel", *extra]]
    if requirements:
        steps.append([py, "-m", "pip", "install", "-r", requirements])

    def done(job):
        _remember(target, "venv", True)
        if on_created:
            on_created(target)

    env = activation_env(target, packaging.command_env())
    return jobs.start(jobs.Job(f"Creating virtual environment {name}", steps, env=env, on_success=done,
                               meta={"create": name}))


def create_conda(name: str, python_version: str = "", packages=None, environment_file: Path | None = None,
                 on_created=None) -> jobs.Job:
    name = _validate_name(name)
    info = conda_info(refresh=True)
    if not info:
        raise EnvError("conda was not found. Install Anaconda, Miniconda or Miniforge first.")
    if any(Path(p).name == name for p in info["envs"]):
        raise EnvError(f"A conda environment named {name} already exists.")
    tool = _conda_tool()
    cleanup = None
    if environment_file:
        source = _rewrite_environment_file(environment_file)
        cleanup = lambda: os.unlink(source)  # noqa: E731
        # "conda env create" takes channels from the file (rewritten for the configured mirrors).
        steps = [[tool, "env", "create", "-y", "-n", name, "-f", source]]
    else:
        version = (python_version or "").strip()
        if version and not re.fullmatch(r"\d+(\.\d+){0,2}", version):
            raise EnvError("Python version should look like 3.12.")
        extra = _check_specs(packages) if packages else []
        steps = [[tool, "create", "-y", "-n", name, f"python={version}" if version else "python", "ipykernel", *extra,
                  *packaging.conda_channel_args()]]

    def done(job):
        fresh = conda_info(refresh=True) or {"envs": []}
        prefix = next((Path(p) for p in fresh["envs"] if Path(p).name == name), None)
        if not prefix:
            raise EnvError("The environment was created but conda does not list it.")
        _remember(prefix, "conda", True)
        if on_created:
            on_created(prefix)

    env = {**os.environ, **packaging.command_env()}
    return jobs.start(jobs.Job(f"Creating conda environment {name}", steps, env=env, on_success=done,
                               cleanup=cleanup, meta={"create": name}))


def delete_env(env: dict, delete_files: bool, in_use: bool) -> jobs.Job | None:
    """Remove an environment from the list, and from disk when ``delete_files``."""
    from core.models import PythonEnv, Project

    if env["is_app"]:
        raise EnvError("The app's own environment cannot be removed.")
    if env["is_conda_base"]:
        raise EnvError("conda's base environment cannot be removed.")
    if in_use and delete_files:
        raise EnvError("A notebook kernel is running in this environment. Shut it down first.")
    _busy(env)
    prefix = Path(env["path"])

    def forget(_job=None):
        PythonEnv.objects.filter(path=env["path"]).delete()
        Project.objects.filter(env_path=env["path"]).update(env_path="")
        _version_cache.pop(norm(prefix), None)
        _conda_cache["time"] = 0

    if not delete_files:
        if env["kind"] == "conda" and env["source"] == "conda":
            raise EnvError("conda environments are listed by conda itself; delete it to remove it from the list.")
        forget()
        return None
    if env["kind"] == "conda" and conda_info():
        cmd = [_conda_tool(prefer_mamba=False), "env", "remove", "-y", "-p", prefix]
        return jobs.start(jobs.Job(f"Deleting conda environment {env['name']}", [cmd], on_success=forget,
                                   meta={"env": env["id"]}))
    if not (prefix / "pyvenv.cfg").exists():
        raise EnvError("This folder does not look like a virtual environment, so it was not deleted.")
    shutil.rmtree(prefix)
    forget()
    return None


# ---------------------------------------------------------------- project environment files

REQUIREMENTS = "requirements.txt"
ENVIRONMENT_YML = "environment.yml"


def _yaml_scalar(value: str) -> str:
    return value if re.fullmatch(r"[A-Za-z0-9_.=<>!~*/:@+-]+", value) and not value.startswith(("*", "@")) else json.dumps(value)


def _channel_name(channel: str) -> str:
    """Map a mirror URL back to the channel name so the file works for collaborators anywhere."""
    if "://" not in channel:
        return channel
    if "conda-forge" in channel:
        return "conda-forge"
    if re.search(r"/(pkgs/)?(main|r|msys2)/?$", channel):
        return "defaults"
    return channel


def write_environment_yml(path: Path, name: str, channels: list[str], deps: list[str], pip: list[str]) -> None:
    lines = [f"name: {_yaml_scalar(name)}", "channels:"]
    lines += [f"  - {_yaml_scalar(c)}" for c in channels] or ["  - conda-forge"]
    lines.append("dependencies:")
    lines += [f"  - {_yaml_scalar(d)}" for d in deps]
    if pip:
        if not any(d == "pip" or d.startswith(("pip=", "pip>", "pip<")) for d in deps):
            lines.append("  - pip")
        lines.append("  - pip:")
        lines += [f"      - {_yaml_scalar(p)}" for p in pip]
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def export_env_file(env: dict, project_root: Path, project_name: str) -> str:
    """Write requirements.txt (venv) or environment.yml (conda) to the project folder."""
    prefix = Path(env["path"])
    if env["kind"] == "conda" and conda_info():
        conda = conda_info()["exe"]
        exported = _run_json([conda, "env", "export", "-p", prefix, "--from-history", "--json"])
        deps = [d for d in exported.get("dependencies", []) if isinstance(d, str)]
        channels = list(dict.fromkeys(_channel_name(c) for c in exported.get("channels", [])))
        installed = _run_json([conda, "list", "-p", prefix, "--json"])
        pip = sorted(f"{i['name']}=={i['version']}" for i in installed if i.get("channel") == "pypi")
        write_environment_yml(project_root / ENVIRONMENT_YML, re.sub(r"[^A-Za-z0-9._-]", "-", project_name) or "project",
                              channels or ["conda-forge"], deps, pip)
        return ENVIRONMENT_YML
    out = subprocess.run([env["python"], "-m", "pip", "freeze", "--exclude-editable", "--disable-pip-version-check"],
                         capture_output=True, text=True, timeout=120, env=activation_env(prefix),
                         creationflags=subprocess.CREATE_NO_WINDOW if WINDOWS else 0)
    if out.returncode != 0:
        raise EnvError(f"pip freeze failed: {out.stderr.strip()[-500:]}")
    lines = [ln for ln in out.stdout.splitlines() if ln.strip() and not ln.startswith("#")]
    header = "# Python packages for this project's notebooks.\n# Recreate with: python -m pip install -r requirements.txt\n"
    (project_root / REQUIREMENTS).write_text(header + "\n".join(lines) + "\n", encoding="utf-8")
    return REQUIREMENTS


def _parse_environment_yml(text: str) -> dict:
    """Read the parts of environment.yml we need (name, channels, dependencies incl. pip) without PyYAML."""
    data: dict = {"channels": [], "dependencies": [], "pip": []}
    section = None
    pip_indent = -1  # indentation of "- pip:" while reading its items
    for raw in text.splitlines():
        line = raw.split(" #", 1)[0].rstrip()
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        indent = len(line) - len(line.lstrip())
        stripped = line.strip()
        if indent == 0 and not stripped.startswith("- "):
            key, _, value = stripped.partition(":")
            section = key.strip()
            pip_indent = -1
            if value.strip():
                data[section] = value.strip().strip("\"'")
            continue
        if not stripped.startswith("- "):
            continue
        item = stripped[2:].strip().strip("\"'")
        if section == "dependencies":
            if item.replace(" ", "") == "pip:":
                pip_indent = indent
                continue
            if 0 <= pip_indent < indent:
                data["pip"].append(item)
            else:
                pip_indent = -1
                data["dependencies"].append(item)
        elif section == "channels":
            data["channels"].append(item)
    return data


def _rewrite_environment_file(path: Path) -> str:
    """Copy environment.yml, pointing its channels at the configured mirrors."""
    data = _parse_environment_yml(path.read_text(encoding="utf-8"))
    channels = packaging.get_config().get("conda_channels") or data["channels"] or ["conda-forge"]
    deps = data["dependencies"]
    if not any(re.match(r"ipykernel\b", d) for d in deps):
        deps.append("ipykernel")
    fd, tmp = tempfile.mkstemp(suffix=".yml", prefix="dm-env-")
    os.close(fd)
    write_environment_yml(Path(tmp), data.get("name") or "project", channels, deps, data["pip"])
    return tmp


def project_env_files(root: Path) -> dict:
    return {"requirements": (root / REQUIREMENTS).is_file(), "environment": (root / ENVIRONMENT_YML).is_file()}
