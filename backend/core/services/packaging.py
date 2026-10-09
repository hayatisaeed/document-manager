"""Package sources: PyPI index mirrors, conda channel mirrors and an HTTP proxy.

The settings apply only to the pip and conda commands the app runs (and to
notebook kernels, so ``%pip install`` uses them too). They are passed through
environment variables and command-line flags; the user's own ``pip.conf`` and
``.condarc`` are never written.
"""
import html
import json
import os
import re
import time
import urllib.error
import urllib.parse
import urllib.request

from django.conf import settings

OFFICIAL_PYPI = "https://pypi.org/simple"

# Mirror presets. Third-party mirrors come and go: the Settings page has a speed
# test, and the official index is always one click away.
PIP_PRESETS = [
    {"id": "pypi", "name": "PyPI (official)", "region": "official", "url": OFFICIAL_PYPI},
    # Iran
    {"id": "runflare", "name": "Runflare", "region": "iran", "url": "https://mirror-pypi.runflare.com/simple"},
    {"id": "liara", "name": "Liara", "region": "iran", "url": "https://package-mirror.liara.ir/repository/pypi/simple"},
    {"id": "kargadan", "name": "Kargadan", "region": "iran", "url": "https://mirror.kargadan.ir/repository/pypi-group/simple"},
    {"id": "ito", "name": "ITO (Information Technology Organization)", "region": "iran",
     "url": "https://archive.ito.gov.ir/mirror2/python/simple"},
    {"id": "novincloud", "name": "NovinCloud", "region": "iran",
     "url": "https://mirror.novin.cloud/artifactory/api/pypi/pypi/simple"},
    {"id": "ferdowsi", "name": "Ferdowsi Cloud", "region": "iran",
     "url": "https://mirror.ferdowsi.cloud/artifactory/api/pypi/pip-virtual/simple"},
    {"id": "chabokan", "name": "Chabokan", "region": "iran", "url": "https://mirror2.chabokan.net/registry/pypi/simple"},
    {"id": "devneeds", "name": "DevNeeds", "region": "iran", "url": "https://pypi.devneeds.ir/simple"},
    # China
    {"id": "tsinghua", "name": "Tsinghua University (TUNA)", "region": "china", "url": "https://pypi.tuna.tsinghua.edu.cn/simple"},
    {"id": "aliyun", "name": "Alibaba Cloud (Aliyun)", "region": "china", "url": "https://mirrors.aliyun.com/pypi/simple"},
    {"id": "ustc", "name": "USTC", "region": "china", "url": "https://mirrors.ustc.edu.cn/pypi/simple"},
]

CONDA_PRESETS = [
    {"id": "conda-forge", "name": "conda-forge (official)", "region": "official",
     "url": "https://conda.anaconda.org/conda-forge"},
    {"id": "prefix", "name": "conda-forge on prefix.dev (CDN)", "region": "official",
     "url": "https://prefix.dev/conda-forge"},
    # Iran
    {"id": "kargadan", "name": "Kargadan (conda-forge)", "region": "iran",
     "url": "https://mirror.kargadan.ir/repository/conda-forge-proxy"},
    # China
    {"id": "tsinghua", "name": "Tsinghua University (conda-forge)", "region": "china",
     "url": "https://mirrors.tuna.tsinghua.edu.cn/anaconda/cloud/conda-forge"},
    {"id": "ustc", "name": "USTC (conda-forge)", "region": "china",
     "url": "https://mirrors.ustc.edu.cn/anaconda/cloud/conda-forge"},
    {"id": "aliyun", "name": "Alibaba Cloud (conda-forge)", "region": "china",
     "url": "https://mirrors.aliyun.com/anaconda/cloud/conda-forge"},
]

DEFAULTS = {
    "pip_index_url": "",  # empty: pip's own configuration (normally pypi.org)
    "pip_extra_index_urls": [],
    "pip_trusted_hosts": [],
    "conda_channels": [],  # empty: conda's own configuration (.condarc)
    "use_mamba": True,
    "http_proxy": "",
    "https_proxy": "",
    "no_proxy": "",
}


class PackagingError(Exception):
    pass


def _url(value: str, field: str) -> str:
    value = (value or "").strip()
    if not value:
        return ""
    parsed = urllib.parse.urlparse(value)
    if parsed.scheme not in ("http", "https", "socks5", "socks5h") or not parsed.netloc:
        raise PackagingError(f"{field}: “{value}” is not a valid URL.")
    return value.rstrip("/")


def _list(value) -> list[str]:
    if isinstance(value, str):
        value = re.split(r"[\s,]+", value)
    return [v.strip() for v in value or [] if v and v.strip()]


def normalize_config(data: dict) -> dict:
    """Validate settings from the user (or the installer) and fill in defaults."""
    out = dict(DEFAULTS)
    data = data or {}
    out["pip_index_url"] = _url(data.get("pip_index_url", ""), "PyPI index")
    out["pip_extra_index_urls"] = [_url(u, "Extra index") for u in _list(data.get("pip_extra_index_urls"))]
    out["pip_trusted_hosts"] = [h.removeprefix("https://").removeprefix("http://").split("/")[0]
                                for h in _list(data.get("pip_trusted_hosts"))]
    channels = []
    for c in _list(data.get("conda_channels")):
        # Channel names (conda-forge, bioconda) are fine as well as URLs.
        channels.append(_url(c, "Conda channel") if "://" in c else c)
    out["conda_channels"] = channels
    out["use_mamba"] = bool(data.get("use_mamba", True))
    for key in ("http_proxy", "https_proxy"):
        out[key] = _url(data.get(key, ""), "Proxy")
    out["no_proxy"] = ",".join(_list(data.get("no_proxy")))
    return out


def get_config() -> dict:
    from core.models import AppSettings

    s = AppSettings.load()
    if not s.package_config and settings.PACKAGE_DEFAULTS:
        # First start after the installer: take over the sources chosen there.
        try:
            s.package_config = normalize_config(json.loads(settings.PACKAGE_DEFAULTS))
            s.save(update_fields=["package_config"])
        except (ValueError, PackagingError):
            pass
    return {**DEFAULTS, **(s.package_config or {})}


def save_config(data: dict) -> dict:
    from core.models import AppSettings

    s = AppSettings.load()
    s.package_config = normalize_config(data)
    s.save(update_fields=["package_config"])
    return s.package_config


def proxy_env(config: dict | None = None) -> dict:
    config = config or get_config()
    env = {}
    for key in ("http_proxy", "https_proxy", "no_proxy"):
        if config.get(key):
            env[key] = env[key.upper()] = config[key]
    return env


def pip_env(config: dict | None = None) -> dict:
    """Environment variables that make pip use the configured sources."""
    config = config or get_config()
    env = proxy_env(config)
    if config.get("pip_index_url"):
        env["PIP_INDEX_URL"] = config["pip_index_url"]
    if config.get("pip_extra_index_urls"):
        env["PIP_EXTRA_INDEX_URL"] = " ".join(config["pip_extra_index_urls"])
    hosts = list(config.get("pip_trusted_hosts") or [])
    for url in [config.get("pip_index_url"), *config.get("pip_extra_index_urls", [])]:
        # A plain-http mirror is refused by pip unless its host is trusted.
        if url and url.startswith("http://"):
            hosts.append(urllib.parse.urlparse(url).netloc)
    if hosts:
        env["PIP_TRUSTED_HOST"] = " ".join(dict.fromkeys(hosts))
    env["PIP_DISABLE_PIP_VERSION_CHECK"] = "1"
    return env


def command_env(config: dict | None = None) -> dict:
    """Variables added to every pip/conda command and notebook kernel the app starts."""
    config = config or get_config()
    return {**pip_env(config), "PYTHONUNBUFFERED": "1", "PYTHONIOENCODING": "utf-8"}


def conda_channel_args(config: dict | None = None) -> list[str]:
    config = config or get_config()
    channels = config.get("conda_channels") or []
    if not channels:
        return []
    args = ["--override-channels"]
    for c in channels:
        args += ["-c", c]
    return args


# ---------------------------------------------------------------- network helpers

def _opener(config: dict):
    proxies = {k.split("_")[0]: config[k] for k in ("http_proxy", "https_proxy") if config.get(k)}
    return urllib.request.build_opener(urllib.request.ProxyHandler(proxies) if proxies else urllib.request.ProxyHandler())


def test_source(kind: str, url: str, timeout: float = 10.0) -> dict:
    """Time a small request to a PyPI index or conda channel."""
    config = get_config()
    url = _url(url, "URL")
    if kind == "pip":
        probe = url + "/pip/"
    elif kind == "conda":
        probe = url + "/noarch/repodata.json"
    else:
        raise PackagingError("kind must be pip or conda")
    req = urllib.request.Request(probe, headers={"Range": "bytes=0-2047", "User-Agent": "document-manager"})
    start = time.monotonic()
    try:
        with _opener(config).open(req, timeout=timeout) as resp:
            resp.read(2048)
            status = resp.status
    except urllib.error.HTTPError as exc:
        return {"url": url, "ok": False, "ms": None, "error": f"HTTP {exc.code}"}
    except (OSError, ValueError) as exc:
        reason = getattr(exc, "reason", exc)
        return {"url": url, "ok": False, "ms": None, "error": str(reason)[:200]}
    return {"url": url, "ok": 200 <= status < 300, "ms": round((time.monotonic() - start) * 1000), "error": None}


def _normalize_name(name: str) -> str:
    return re.sub(r"[-_.]+", "-", name).lower()


_VERSION_RE = re.compile(r"^(?:\d+!)?\d+(?:\.\d+)*(?:[._-]?(?:a|b|rc|alpha|beta|pre|preview|c)\d*)?"
                         r"(?:[._-]?(?:post|rev|r)\d*)?(?:[._-]?dev\d*)?(?:\+[a-z0-9.]+)?$", re.I)


def _versions_from_files(name: str, filenames: list[str]) -> list[str]:
    norm = _normalize_name(name)
    versions = set()
    for fn in filenames:
        fn = urllib.parse.unquote(fn.split("#")[0].rsplit("/", 1)[-1])
        if fn.endswith(".whl"):
            parts = fn[:-4].split("-")
            if len(parts) >= 5 and _normalize_name(parts[0]) == norm:
                versions.add(parts[1])
            continue
        for ext in (".tar.gz", ".zip", ".tar.bz2", ".tgz"):
            if fn.endswith(ext):
                stem = fn[: -len(ext)]
                project, _, version = stem.rpartition("-")
                if project and _normalize_name(project) == norm and _VERSION_RE.match(version):
                    versions.add(version)
    return sorted(versions, key=_version_key, reverse=True)


def _version_key(v: str):
    parts = []
    for piece in re.split(r"[.+!-]", v):
        m = re.match(r"(\d+)(.*)", piece)
        parts.append((int(m.group(1)), m.group(2)) if m else (-1, piece))
    return parts


def lookup_pip(name: str, timeout: float = 20.0) -> dict:
    """Versions of one package on the configured PyPI index (PEP 503/691 simple API).

    pip has no search command and PyPI has turned off its search API, so this
    looks up an exact project name, which works the same on every mirror.
    """
    name = name.strip()
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]*", name):
        raise PackagingError("Enter a package name, for example numpy.")
    config = get_config()
    index = config.get("pip_index_url") or OFFICIAL_PYPI
    url = f"{index}/{_normalize_name(name)}/"
    req = urllib.request.Request(url, headers={
        "Accept": "application/vnd.pypi.simple.v1+json, text/html;q=0.5", "User-Agent": "document-manager"})
    try:
        with _opener(config).open(req, timeout=timeout) as resp:
            body = resp.read().decode("utf-8", "replace")
            ctype = resp.headers.get("Content-Type", "")
    except urllib.error.HTTPError as exc:
        if exc.code == 404:
            return {"name": name, "found": False, "versions": [], "index": index}
        raise PackagingError(f"The package index answered HTTP {exc.code} ({index}).") from exc
    except OSError as exc:
        raise PackagingError(f"Could not reach the package index {index}: {getattr(exc, 'reason', exc)}") from exc
    if "json" in ctype:
        data = json.loads(body)
        versions = data.get("versions")
        if versions:
            versions = sorted(versions, key=_version_key, reverse=True)
        else:
            versions = _versions_from_files(name, [f.get("filename", "") for f in data.get("files", [])])
    else:
        hrefs = re.findall(r'href="([^"]+)"', body)
        names = [html.unescape(h) for h in hrefs] + re.findall(r">([^<>]+)</a>", body)
        versions = _versions_from_files(name, names)
    return {"name": name, "found": bool(versions), "versions": versions[:100], "index": index}
