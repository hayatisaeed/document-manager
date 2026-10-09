"""Run notebook code cells in local Jupyter kernels.

One kernel per open notebook, kept in this process. The app therefore runs as
a single process (waitress with threads), so every request sees the same kernels.

Each kernel has two reader threads:

* the iopub reader records every message in an event log (read by the browser
  through long polling, which drives live ipywidgets) and hands cell outputs
  to the execution that produced them;
* the shell reader delivers execute replies to the request waiting for them.

Outputs captured by an ipywidgets ``Output`` widget (whose ``msg_id`` state
names the request it captures) go only to the event log, not to the cell.
"""
import atexit
import base64
import os
import sys
import threading
import time
from collections import deque
from pathlib import Path

try:
    from jupyter_client import KernelManager
    from jupyter_client.kernelspec import KernelSpec, KernelSpecManager, NoSuchKernel
except ImportError:  # pragma: no cover - optional dependency
    KernelManager = None
    KernelSpecManager = None

from . import envs, packaging

if KernelSpecManager is not None:
    class EnvKernelSpecManager(KernelSpecManager):
        """Installed Jupyter kernels plus a Python kernel for an environment (``dm-env-<id>``).

        Environment kernels need no kernel.json: they run ``python -m ipykernel_launcher``
        from the environment, so any conda env or venv with ipykernel works. The spec is
        resolved before launching (jupyter_client asks for it from inside its event loop,
        where the database cannot be used).
        """

        def __init__(self, env: dict | None = None, **kwargs):
            super().__init__(**kwargs)
            self._env = env

        def get_kernel_spec(self, kernel_name):
            if self._env and kernel_name == self._env["kernel"]:
                return KernelSpec(argv=[self._env["python"], "-m", "ipykernel_launcher", "-f", "{connection_file}"],
                                  display_name=self._env["name"], language="python", resource_dir="")
            if kernel_name.startswith(envs.KERNEL_PREFIX):
                raise NoSuchKernel(kernel_name)
            return super().get_kernel_spec(kernel_name)

OUTPUT_TYPES = {"stream", "display_data", "execute_result", "error", "clear_output", "update_display_data"}
# "status" lets widgets know when the kernel has processed their messages.
EVENT_TYPES = OUTPUT_TYPES | {"comm_open", "comm_msg", "comm_close", "status"}
MAX_EVENTS = 5000


class KernelError(Exception):
    def __init__(self, message: str, code: str = "", **extra):
        super().__init__(message)
        self.code = code
        self.extra = extra


def _encode_buffers(buffers) -> list[str]:
    return [base64.b64encode(bytes(b)).decode() for b in buffers or []]


class _Execution:
    def __init__(self):
        self.outputs: list[dict] = []
        self.reply: dict | None = None
        self.idle = threading.Event()
        self.replied = threading.Event()


class _Session:
    def __init__(self, km, kc, name: str):
        self.km = km
        self.kc = kc
        self.name = name
        self.send_lock = threading.Lock()  # zmq sockets are not thread-safe
        self.run_lock = threading.Lock()  # one cell at a time, like Jupyter
        self.busy = False
        self.alive = True
        self.executions: dict[str, _Execution] = {}
        # Live widgets
        self.events: deque[dict] = deque(maxlen=MAX_EVENTS)
        self.seq = 0
        self.events_cond = threading.Condition()
        self.output_models: dict[str, str] = {}  # comm_id -> msg_id being captured
        self.threads = [threading.Thread(target=self._read_iopub, daemon=True),
                        threading.Thread(target=self._read_shell, daemon=True)]
        for t in self.threads:
            t.start()

    # ------------------------------------------------------------ readers
    def _read_iopub(self):
        while self.alive:
            try:
                msg = self.kc.get_iopub_msg(timeout=0.5)
            except Exception:
                continue
            self._handle_iopub(msg)

    def _read_shell(self):
        while self.alive:
            try:
                msg = self.kc.get_shell_msg(timeout=0.5)
            except Exception:
                continue
            parent = msg.get("parent_header", {}).get("msg_id")
            execution = self.executions.get(parent)
            if execution and msg["header"]["msg_type"] == "execute_reply":
                execution.reply = msg
                execution.replied.set()

    def _track_output_widgets(self, kind: str, content: dict):
        """Remember which request each Output widget is capturing."""
        comm_id = content.get("comm_id")
        data = content.get("data") or {}
        state = data.get("state") or {}
        if kind == "comm_open" and state.get("_model_name") == "OutputModel":
            self.output_models[comm_id] = state.get("msg_id", "")
        elif kind == "comm_msg" and comm_id in self.output_models and "msg_id" in state:
            self.output_models[comm_id] = state["msg_id"]
        elif kind == "comm_close":
            self.output_models.pop(comm_id, None)

    def _handle_iopub(self, msg: dict):
        kind = msg["header"]["msg_type"]
        content = msg.get("content", {})
        parent = msg.get("parent_header", {}).get("msg_id", "")
        if kind in ("comm_open", "comm_msg", "comm_close"):
            self._track_output_widgets(kind, content)
        captured = kind in OUTPUT_TYPES and parent and parent in self.output_models.values()
        if kind in EVENT_TYPES:
            self._push_event({"msg_type": kind, "parent_msg_id": parent, "content": content,
                              "metadata": msg.get("metadata", {}),
                              "buffers": _encode_buffers(msg.get("buffers")), "captured": bool(captured)})
        execution = self.executions.get(parent)
        if not execution:
            return
        if kind == "status" and content.get("execution_state") == "idle":
            execution.idle.set()
        elif kind in OUTPUT_TYPES and not captured:
            _to_output(kind, content, execution.outputs)

    def _push_event(self, event: dict):
        with self.events_cond:
            self.seq += 1
            event["seq"] = self.seq
            self.events.append(event)
            self.events_cond.notify_all()

    # ------------------------------------------------------------ requests
    def execute(self, code: str, timeout: int) -> dict:
        with self.run_lock:
            # Register before sending: iopub messages for it can arrive right away.
            msg = self.kc.session.msg("execute_request", {
                "code": code, "silent": False, "store_history": True,
                "user_expressions": {}, "allow_stdin": False, "stop_on_error": True})
            msg_id = msg["header"]["msg_id"]
            execution = _Execution()
            self.executions[msg_id] = execution
            self.busy = True
            try:
                with self.send_lock:
                    self.kc.session.send(self.kc.shell_channel.socket, msg)
                deadline = time.time() + timeout
                while not (execution.replied.is_set() and execution.idle.is_set()):
                    if time.time() > deadline:
                        raise KernelError("The cell ran for too long and was stopped waiting.")
                    if not self.km.is_alive():
                        raise KernelError("The kernel stopped (it may have run out of memory). Restart it to continue.")
                    execution.idle.wait(0.2)
                content = execution.reply.get("content", {}) if execution.reply else {}
                return {"outputs": execution.outputs, "execution_count": content.get("execution_count"),
                        "status": content.get("status", "ok"), "msg_id": msg_id}
            finally:
                self.executions.pop(msg_id, None)
                self.busy = False

    def send_comm(self, msg_type: str, content: dict, buffers: list[bytes], metadata: dict | None = None,
                  msg_id: str | None = None) -> str:
        msg = self.kc.session.msg(msg_type, content, metadata=metadata or {})
        if msg_id:
            # ipywidgets matches echoed updates by the id it was given when sending.
            msg["header"]["msg_id"] = msg["msg_id"] = msg_id
        with self.send_lock:
            self.kc.session.send(self.kc.shell_channel.socket, msg, buffers=buffers)
        return msg["header"]["msg_id"]

    def events_since(self, since: int, wait: float) -> tuple[int, list[dict]]:
        with self.events_cond:
            if self.seq <= since and wait > 0:
                self.events_cond.wait(wait)
            return self.seq, [e for e in self.events if e["seq"] > since]

    def stop(self):
        self.alive = False
        with self.events_cond:
            self.events_cond.notify_all()
        try:
            self.kc.stop_channels()
            self.km.shutdown_kernel(now=True)
        except Exception:
            pass


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
    """Installed Jupyter kernels other than the default Python one (environments replace it)."""
    if KernelSpecManager is None:
        return []
    result = []
    for name, info in KernelSpecManager().get_all_specs().items():
        if name == "python3":
            continue
        spec = info.get("spec", {})
        result.append({"name": name, "display_name": spec.get("display_name", name),
                       "language": spec.get("language", "")})
    return sorted(result, key=lambda s: s["display_name"])


def _require():
    if KernelManager is None:
        raise KernelError("Jupyter is not installed. Re-run the installer, or `pip install ipykernel jupyter_client`.")


def _session(slug: str, path: str) -> _Session | None:
    session = _sessions.get((slug, path))
    if session and session.km.is_alive():
        return session
    return None


def status(slug: str, path: str) -> dict:
    session = _session(slug, path)
    if not session:
        return {"running": False, "busy": False, "kernel": None, "session": None}
    return {"running": True, "busy": session.busy, "kernel": session.name, "session": id(session)}


def in_use(kernel_name: str) -> bool:
    return any(s.name == kernel_name and s.km.is_alive() for s in _sessions.values())


def _launch(name: str) -> tuple[dict | None, dict]:
    """Check the kernel can start; return its environment (if any) and process variables."""
    extra = packaging.command_env()
    env = envs.env_by_kernel(name)
    if env:
        if not env["has_ipykernel"]:
            raise KernelError(f"The environment “{env['name']}” does not have ipykernel, which notebooks need. "
                              "Install it from Python environments.", code="missing_ipykernel", env=env["id"])
        return env, envs.activation_env(Path(env["path"]), extra)
    names = KernelSpecManager().find_kernel_specs()
    if name not in names:
        if name.startswith(envs.KERNEL_PREFIX):
            raise KernelError("This notebook's environment no longer exists. Choose another one.")
        raise KernelError(f"The Jupyter kernel “{name}” is not installed.")
    return None, {**os.environ, **extra}


def start(slug: str, root: Path, path: str, kernel_name: str | None = None) -> dict:
    """Start (or switch) the notebook's kernel. ``kernel_name`` defaults to the app's environment."""
    _require()
    key = (slug, path)
    name = kernel_name or envs.kernel_name(sys.prefix)
    with _registry_lock:
        session = _sessions.get(key)
        if session and session.km.is_alive() and name == session.name:
            return status(slug, path)
        python_env, variables = _launch(name)
        if session:
            session.stop()
            _sessions.pop(key, None)
        km = KernelManager(kernel_name=name, kernel_spec_manager=EnvKernelSpecManager(env=python_env))
        km.start_kernel(cwd=str((root / path).parent), env=variables)
        kc = km.client()
        kc.start_channels()
        try:
            kc.wait_for_ready(timeout=60)
        except RuntimeError as exc:
            km.shutdown_kernel(now=True)
            raise KernelError(f"The kernel did not start: {exc}") from exc
        _sessions[key] = _Session(km, kc, name)
    return status(slug, path)


def _to_output(kind: str, content: dict, outputs: list[dict]) -> None:
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


def execute(slug: str, root: Path, path: str, code: str, timeout: int = 3600, kernel_name: str | None = None) -> dict:
    session = _session(slug, path)
    if not session:
        start(slug, root, path, kernel_name)
        session = _sessions[(slug, path)]
    return session.execute(code, timeout)


def send_comm(slug: str, path: str, msg_type: str, content: dict, buffers: list[str] | None = None,
              metadata: dict | None = None, msg_id: str | None = None) -> str:
    """Forward a widget message (comm_open / comm_msg / comm_close) from the browser."""
    if msg_type not in ("comm_open", "comm_msg", "comm_close", "comm_info_request"):
        raise KernelError(f"Unsupported message type: {msg_type}")
    session = _session(slug, path)
    if not session:
        raise KernelError("The kernel is not running.")
    raw = [base64.b64decode(b) for b in buffers or []]
    return session.send_comm(msg_type, content, raw, metadata, msg_id)


def events(slug: str, path: str, since: int, wait: float = 20.0) -> dict:
    session = _session(slug, path)
    if not session:
        return {"seq": since, "events": [], "running": False}
    seq, items = session.events_since(since, wait)
    return {"seq": seq, "events": items, "running": True, "session": id(session)}


def interrupt(slug: str, path: str) -> None:
    session = _session(slug, path)
    if session:
        session.km.interrupt_kernel()


def restart(slug: str, root: Path, path: str, kernel_name: str | None = None) -> dict:
    session = _sessions.get((slug, path))
    name = session.name if session else kernel_name
    shutdown(slug, path)
    return start(slug, root, path, name)


def shutdown(slug: str, path: str) -> None:
    with _registry_lock:
        session = _sessions.pop((slug, path), None)
    if session:
        session.stop()


@atexit.register
def _shutdown_all():
    for session in list(_sessions.values()):
        session.stop()
    _sessions.clear()
