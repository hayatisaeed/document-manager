"""Run notebook code cells in local Jupyter kernels.

One kernel per open notebook, kept in this process. The app therefore runs as
a single process (waitress with threads), so every request sees the same kernels.
"""
import atexit
import threading
import time
from pathlib import Path

try:
    from jupyter_client import KernelManager
    from jupyter_client.kernelspec import KernelSpecManager
except ImportError:  # pragma: no cover - optional dependency
    KernelManager = None
    KernelSpecManager = None


class KernelError(Exception):
    pass


class _Session:
    def __init__(self, km, kc, name: str):
        self.km = km
        self.kc = kc
        self.name = name
        self.lock = threading.Lock()
        self.busy = False
        self.started = time.time()


_sessions: dict[tuple[str, str], _Session] = {}
_registry_lock = threading.Lock()


def available() -> bool:
    if KernelSpecManager is None:
        return False
    try:
        return bool(KernelSpecManager().find_kernel_specs())
    except Exception:
        return False


def specs() -> list[dict]:
    if KernelSpecManager is None:
        return []
    result = []
    for name, info in KernelSpecManager().get_all_specs().items():
        spec = info.get("spec", {})
        result.append({"name": name, "display_name": spec.get("display_name", name),
                       "language": spec.get("language", "")})
    return sorted(result, key=lambda s: s["display_name"])


def _require():
    if KernelManager is None:
        raise KernelError("Jupyter is not installed. Re-run the installer, or `pip install ipykernel jupyter_client`.")


def status(slug: str, path: str) -> dict:
    session = _sessions.get((slug, path))
    if not session or not session.km.is_alive():
        return {"running": False, "busy": False, "kernel": None}
    return {"running": True, "busy": session.busy, "kernel": session.name}


def start(slug: str, root: Path, path: str, kernel_name: str | None = None) -> dict:
    _require()
    key = (slug, path)
    with _registry_lock:
        session = _sessions.get(key)
        if session and session.km.is_alive() and (not kernel_name or kernel_name == session.name):
            return status(slug, path)
        if session:
            _stop(session)
        names = KernelSpecManager().find_kernel_specs()
        name = kernel_name if kernel_name in names else ("python3" if "python3" in names else next(iter(names), None))
        if not name:
            raise KernelError("No Jupyter kernels found. Install one with `pip install ipykernel`.")
        km = KernelManager(kernel_name=name)
        cwd = (root / path).parent
        km.start_kernel(cwd=str(cwd))
        kc = km.client()
        kc.start_channels()
        try:
            kc.wait_for_ready(timeout=60)
        except RuntimeError as exc:
            km.shutdown_kernel(now=True)
            raise KernelError(f"The kernel did not start: {exc}") from exc
        _sessions[key] = _Session(km, kc, name)
    return status(slug, path)


def _to_output(msg: dict, outputs: list[dict]) -> None:
    kind = msg["header"]["msg_type"]
    content = msg["content"]
    if kind == "stream":
        if outputs and outputs[-1].get("output_type") == "stream" and outputs[-1].get("name") == content["name"]:
            outputs[-1]["text"] += content["text"]
        else:
            outputs.append({"output_type": "stream", "name": content["name"], "text": content["text"]})
    elif kind in ("display_data", "execute_result"):
        out = {"output_type": kind, "data": content.get("data", {}), "metadata": content.get("metadata", {})}
        if kind == "execute_result":
            out["execution_count"] = content.get("execution_count")
        outputs.append(out)
    elif kind == "error":
        outputs.append({"output_type": "error", "ename": content.get("ename", ""),
                        "evalue": content.get("evalue", ""), "traceback": content.get("traceback", [])})
    elif kind == "clear_output":
        outputs.clear()


def execute(slug: str, root: Path, path: str, code: str, timeout: int = 3600) -> dict:
    session = _sessions.get((slug, path))
    if not session or not session.km.is_alive():
        start(slug, root, path)
        session = _sessions[(slug, path)]
    outputs: list[dict] = []
    with session.lock:
        session.busy = True
        try:
            reply = session.kc.execute_interactive(
                code, store_history=True, allow_stdin=False, timeout=timeout,
                output_hook=lambda msg: _to_output(msg, outputs))
        except TimeoutError as exc:
            raise KernelError("The cell ran for too long and was stopped waiting.") from exc
        finally:
            session.busy = False
    content = reply.get("content", {})
    return {"outputs": outputs, "execution_count": content.get("execution_count"),
            "status": content.get("status", "ok")}


def interrupt(slug: str, path: str) -> None:
    session = _sessions.get((slug, path))
    if session:
        session.km.interrupt_kernel()


def restart(slug: str, root: Path, path: str) -> dict:
    session = _sessions.get((slug, path))
    if not session:
        return start(slug, root, path)
    session.km.restart_kernel(now=True)
    session.kc.wait_for_ready(timeout=60)
    return status(slug, path)


def _stop(session: _Session) -> None:
    try:
        session.kc.stop_channels()
        session.km.shutdown_kernel(now=True)
    except Exception:
        pass


def shutdown(slug: str, path: str) -> None:
    with _registry_lock:
        session = _sessions.pop((slug, path), None)
    if session:
        _stop(session)


@atexit.register
def _shutdown_all():
    for session in list(_sessions.values()):
        _stop(session)
    _sessions.clear()
