"""Long-running commands (package installs, environment creation) with live output.

A job runs one or more commands in a background thread. The browser polls
``lines_since`` to show the output as it arrives. Jobs live in this process
only; the app runs as one process (see kernels.py).
"""
import itertools
import os
import subprocess
import sys
import threading
import time
import uuid
from collections.abc import Callable

MAX_LINES = 5000
KEEP_FINISHED = 30


class JobError(Exception):
    pass


class Job:
    def __init__(self, title: str, steps: list[list[str]], env: dict | None = None, cwd: str | None = None,
                 on_success: Callable[["Job"], None] | None = None, cleanup: Callable[[], None] | None = None,
                 meta: dict | None = None):
        self.id = uuid.uuid4().hex[:12]
        self.title = title
        self.steps = [[str(a) for a in step] for step in steps]
        self.env = env
        self.cwd = cwd
        self.on_success = on_success
        self.cleanup = cleanup
        self.meta = meta or {}
        self.lines: list[str] = []
        self.dropped = 0
        self.state = "running"  # running | succeeded | failed | cancelled
        self.error = ""
        self.started = time.time()
        self.finished: float | None = None
        self._proc: subprocess.Popen | None = None
        self._cancel = False
        self._lock = threading.Lock()

    # ------------------------------------------------------------ output
    def log(self, text: str) -> None:
        with self._lock:
            self.lines.append(text)
            if len(self.lines) > MAX_LINES:
                drop = len(self.lines) - MAX_LINES
                del self.lines[:drop]
                self.dropped += drop

    def lines_since(self, since: int) -> tuple[int, list[str]]:
        with self._lock:
            total = self.dropped + len(self.lines)
            start = max(0, since - self.dropped)
            return total, self.lines[start:]

    def summary(self, since: int | None = None) -> dict:
        out = {"id": self.id, "title": self.title, "state": self.state, "error": self.error,
               "started": self.started, "finished": self.finished, "meta": self.meta}
        if since is not None:
            out["next"], out["lines"] = self.lines_since(since)
        return out

    # ------------------------------------------------------------ running
    def _run_step(self, cmd: list[str]) -> int:
        self.log("$ " + " ".join(f'"{a}"' if " " in a else a for a in cmd))
        kwargs = {}
        if sys.platform == "win32":
            kwargs["creationflags"] = subprocess.CREATE_NO_WINDOW
        try:
            self._proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL,
                                          env=self.env, cwd=self.cwd, **kwargs)
        except OSError as exc:
            self.log(f"Could not start {cmd[0]}: {exc}")
            return -1
        buf = b""
        assert self._proc.stdout is not None
        while True:
            chunk = self._proc.stdout.read1(4096) if hasattr(self._proc.stdout, "read1") else self._proc.stdout.read(4096)
            if not chunk:
                break
            buf += chunk
            # Progress bars redraw with \r; keep only complete lines.
            *complete, buf = buf.replace(b"\r\n", b"\n").replace(b"\r", b"\n").split(b"\n")
            for line in complete:
                if line.strip():
                    self.log(line.decode("utf-8", "replace"))
        if buf.strip():
            self.log(buf.decode("utf-8", "replace"))
        return self._proc.wait()

    def run(self) -> None:
        try:
            for cmd in self.steps:
                if self._cancel:
                    break
                code = self._run_step(cmd)
                if self._cancel:
                    break
                if code != 0:
                    self.state = "failed"
                    self.error = f"{os.path.basename(cmd[0])} exited with code {code}"
                    self.log(f"✗ Failed ({self.error}).")
                    return
            if self._cancel:
                self.state = "cancelled"
                self.log("Cancelled.")
                return
            if self.on_success:
                self.on_success(self)
            self.state = "succeeded"
            self.log("✓ Done.")
        except Exception as exc:  # report, never crash the thread silently
            self.state = "failed"
            self.error = str(exc)
            self.log(f"✗ {exc}")
        finally:
            self.finished = time.time()
            if self.cleanup:
                try:
                    self.cleanup()
                except Exception:
                    pass
            # on_success may have used the database from this thread.
            from django.db import connection
            connection.close()

    def cancel(self) -> None:
        self._cancel = True
        proc = self._proc
        if proc and proc.poll() is None:
            proc.terminate()


_jobs: dict[str, Job] = {}
_lock = threading.Lock()
_counter = itertools.count()


def start(job: Job) -> Job:
    with _lock:
        finished = [j for j in _jobs.values() if j.state != "running"]
        for old in sorted(finished, key=lambda j: j.started)[:-KEEP_FINISHED or None]:
            _jobs.pop(old.id, None)
        _jobs[job.id] = job
    threading.Thread(target=job.run, daemon=True, name=f"job-{next(_counter)}").start()
    return job


def get(job_id: str) -> Job:
    job = _jobs.get(job_id)
    if not job:
        raise JobError("This task is no longer known (the app may have restarted).")
    return job


def running_for(key: str, value: str) -> Job | None:
    return next((j for j in _jobs.values() if j.state == "running" and j.meta.get(key) == value), None)


def all_jobs() -> list[Job]:
    return sorted(_jobs.values(), key=lambda j: j.started, reverse=True)
