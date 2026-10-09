"""Thin wrapper around the git command line.

We shell out to ``git`` rather than using a library so that behaviour matches
exactly what users see when they run git themselves in the same repository.
"""
import base64
import os
import subprocess
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlparse

from core.models import AppSettings, Credential


class GitError(Exception):
    pass


ALLOWED_URL_PREFIXES = ("https://", "http://", "ssh://", "git@", "file://", "/")


def check_ref(value: str, what: str = "reference") -> str:
    """Refuse values git could interpret as command-line options."""
    if not value or value.startswith("-") or any(c in value for c in "\0\n\r "):
        raise GitError(f"Invalid {what}: {value!r}")
    return value


def check_url(url: str) -> str:
    """Allow network remotes and local/shared-folder paths; block ``ext::`` style transports."""
    url = (url or "").strip()
    if not url.startswith(ALLOWED_URL_PREFIXES) or "::" in url.split("/")[0]:
        raise GitError("Remote URL must start with https://, ssh://, git@, file:// or /")
    return url


# Unit/record separators used to parse `git log` output safely.
_US = "\x1f"
_RS = "\x1e"


def _identity_env() -> dict:
    s = AppSettings.load()
    name = s.author_name or "Document Manager User"
    email = s.author_email or "user@localhost"
    return {
        "GIT_AUTHOR_NAME": name,
        "GIT_AUTHOR_EMAIL": email,
        "GIT_COMMITTER_NAME": name,
        "GIT_COMMITTER_EMAIL": email,
    }


def run(repo: Path, *args: str, check: bool = True, extra_config: list[str] | None = None,
        input_text: str | None = None, timeout: int = 120) -> subprocess.CompletedProcess:
    cmd = ["git", "-c", "safe.directory=*", "-c", "core.quotepath=false"]
    for c in extra_config or []:
        cmd += ["-c", c]
    cmd += list(args)
    env = {**os.environ, **_identity_env(), "GIT_TERMINAL_PROMPT": "0", "LC_ALL": "C.UTF-8"}
    try:
        proc = subprocess.run(cmd, cwd=repo, env=env, capture_output=True, text=True,
                              input=input_text, timeout=timeout, encoding="utf-8", errors="replace")
    except subprocess.TimeoutExpired as exc:
        raise GitError(f"git {args[0]} timed out") from exc
    if check and proc.returncode != 0:
        raise GitError((proc.stderr or proc.stdout).strip() or f"git {args[0]} failed")
    return proc


def out(repo: Path, *args: str, **kw) -> str:
    return run(repo, *args, **kw).stdout


# ---------------------------------------------------------------- credentials

def auth_config(repo: Path, remote: str) -> list[str]:
    """Return ``-c`` options that authenticate HTTPS requests to ``remote``.

    The token is passed per-command as an HTTP header, so it is never written
    into the repository's config or remote URL.
    """
    url = remote_url(repo, remote)
    if not url:
        return []
    return auth_config_for_url(url)


def auth_config_for_url(url: str) -> list[str]:
    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https") or not parsed.hostname:
        return []  # SSH remotes use the user's SSH keys.
    cred = Credential.objects.filter(host__iexact=parsed.hostname).first()
    if not cred:
        return []
    basic = base64.b64encode(f"{cred.username}:{cred.token}".encode()).decode()
    return ["credential.helper=", f"http.extraHeader=Authorization: Basic {basic}"]


def remote_url(repo: Path, remote: str) -> str | None:
    proc = run(repo, "remote", "get-url", remote, check=False)
    return proc.stdout.strip() if proc.returncode == 0 else None


# ---------------------------------------------------------------- repository

def init(repo: Path) -> None:
    repo.mkdir(parents=True, exist_ok=True)
    # `init -b` needs git 2.28+; setting HEAD directly works with any version.
    run(repo, "init")
    run(repo, "symbolic-ref", "HEAD", "refs/heads/main")


def clone(url: str, dest: Path) -> None:
    check_url(url)
    dest.parent.mkdir(parents=True, exist_ok=True)
    run(dest.parent, "clone", url, dest.name, extra_config=auth_config_for_url(url), timeout=600)


def has_commits(repo: Path) -> bool:
    return run(repo, "rev-parse", "--verify", "HEAD", check=False).returncode == 0


def current_branch(repo: Path) -> str | None:
    proc = run(repo, "symbolic-ref", "--short", "-q", "HEAD", check=False)
    return proc.stdout.strip() or None


def is_merging(repo: Path) -> bool:
    return (repo / ".git" / "MERGE_HEAD").exists()


STATUS_LABELS = {
    "M": "modified", "A": "added", "D": "deleted", "R": "renamed",
    "C": "copied", "U": "conflict", "?": "untracked", "T": "modified",
}


@dataclass
class FileStatus:
    path: str
    status: str
    staged: bool
    orig_path: str | None = None


def status(repo: Path) -> dict:
    raw = out(repo, "status", "--porcelain=v1", "-z", "--untracked-files=all")
    entries = raw.split("\0")
    files: list[dict] = []
    conflicts: list[str] = []
    i = 0
    while i < len(entries):
        entry = entries[i]
        i += 1
        if not entry:
            continue
        x, y, path = entry[0], entry[1], entry[3:]
        orig = None
        if x in "RC":
            orig = entries[i]
            i += 1
        if x == "U" or y == "U" or (x, y) in (("A", "A"), ("D", "D")):
            conflicts.append(path)
            code = "U"
        elif x == "?":
            code = "?"
        else:
            code = y if y != " " else x
        files.append({
            "path": path,
            "status": STATUS_LABELS.get(code, "modified"),
            "staged": x not in (" ", "?"),
            "orig_path": orig,
        })

    branch = current_branch(repo)
    ahead = behind = 0
    upstream = None
    if branch and has_commits(repo):
        up = run(repo, "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}", check=False)
        if up.returncode == 0:
            upstream = up.stdout.strip()
            counts = out(repo, "rev-list", "--left-right", "--count", f"HEAD...{upstream}").split()
            ahead, behind = int(counts[0]), int(counts[1])
    return {
        "branch": branch,
        "upstream": upstream,
        "ahead": ahead,
        "behind": behind,
        "files": files,
        "conflicts": conflicts,
        "merging": is_merging(repo),
        "has_commits": has_commits(repo),
    }


def commit(repo: Path, message: str, paths: list[str] | None = None) -> str:
    if not message.strip():
        raise GitError("A commit message is required.")
    if is_merging(repo):
        if status(repo)["conflicts"]:
            raise GitError("Resolve all conflicts before committing the merge.")
        run(repo, "add", "-A")
        run(repo, "commit", "--no-edit", "-m", message)
    else:
        if paths:
            run(repo, "add", "-A", "--", *paths)
            run(repo, "commit", "-m", message, "--", *paths)
        else:
            run(repo, "add", "-A")
            run(repo, "commit", "-m", message)
    return out(repo, "rev-parse", "HEAD").strip()


LOG_FORMAT = _US.join(["%H", "%h", "%an", "%ae", "%aI", "%P", "%s", "%b"]) + _RS


def log(repo: Path, ref: str | None = None, path: str | None = None,
        limit: int = 50, skip: int = 0) -> list[dict]:
    if not has_commits(repo):
        return []
    args = ["log", f"--format={LOG_FORMAT}", f"--max-count={limit}", f"--skip={skip}"]
    if path:
        args.append("--follow")
    if ref:
        args.append(check_ref(ref))
    args.append("--")
    if path:
        args.append(path)
    commits = []
    for record in out(repo, *args).split(_RS):
        record = record.strip("\n")
        if not record:
            continue
        sha, short, name, email, date, parents, subject, body = record.split(_US)
        commits.append({
            "sha": sha, "short": short, "author": name, "email": email, "date": date,
            "parents": parents.split() if parents else [], "subject": subject, "body": body.strip(),
        })
    return commits


GRAPH_FORMAT = _US.join(["%H", "%h", "%an", "%aI", "%P", "%D", "%s"]) + _RS


def _parse_refs(decoration: str) -> list[dict]:
    """``HEAD -> main, origin/main, tag: v1`` -> typed labels."""
    refs = []
    for part in filter(None, (p.strip() for p in decoration.split(","))):
        if part.startswith("HEAD -> "):
            refs.append({"name": "HEAD", "type": "head"})
            part = part[len("HEAD -> "):]
        elif part == "HEAD":
            refs.append({"name": "HEAD", "type": "head"})
            continue
        if part.startswith("tag: "):
            refs.append({"name": part[5:], "type": "tag"})
        elif part.endswith("/HEAD"):
            continue
        elif part.startswith("refs/stash"):
            refs.append({"name": "stash", "type": "stash"})
        else:
            refs.append({"name": part, "type": "branch"})
    return refs


def graph(repo: Path, limit: int = 200, skip: int = 0) -> dict:
    """Commits on every branch, newest first in topological order, for drawing the commit tree."""
    if not has_commits(repo):
        return {"commits": [], "head": None}
    remotes_prefixes = tuple(name + "/" for name in out(repo, "remote").split())
    commits = []
    raw = out(repo, "log", "--all", "--topo-order", "--decorate=short", f"--max-count={limit}", f"--skip={skip}",
              f"--format={GRAPH_FORMAT}")
    for record in raw.split(_RS):
        record = record.strip("\n")
        if not record:
            continue
        sha, short, name, date, parents, decoration, subject = record.split(_US)
        refs = _parse_refs(decoration)
        for ref in refs:
            if ref["type"] == "branch" and ref["name"].startswith(remotes_prefixes):
                ref["type"] = "remote"
        commits.append({"sha": sha, "short": short, "author": name, "date": date,
                        "parents": parents.split() if parents else [], "refs": refs, "subject": subject})
    return {"commits": commits, "head": out(repo, "rev-parse", "HEAD").strip()}


def _changed_files(repo: Path, *range_args: str, path: str | None = None) -> list[dict]:
    args = ["diff", "--numstat", "-z", "-M", *range_args]
    if path:
        args += ["--", path]
    raw = out(repo, *args)
    files = []
    tokens = raw.split("\0")
    i = 0
    while i < len(tokens):
        tok = tokens[i]
        i += 1
        if not tok:
            continue
        added, deleted, name = tok.split("\t", 2)
        old = None
        if name == "":  # rename: next two tokens are old and new paths
            old, name = tokens[i], tokens[i + 1]
            i += 2
        files.append({
            "path": name,
            "orig_path": old,
            "additions": None if added == "-" else int(added),
            "deletions": None if deleted == "-" else int(deleted),
        })
    return files


EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904"


def show(repo: Path, sha: str) -> dict:
    info = log(repo, ref=sha, limit=1)
    if not info:
        raise GitError("Commit not found.")
    commit_info = info[0]
    parent = commit_info["parents"][0] if commit_info["parents"] else EMPTY_TREE
    return {**commit_info, "files": _changed_files(repo, parent, sha)}


def diff(repo: Path, base: str | None = None, target: str | None = None,
         path: str | None = None) -> dict:
    """Unified diff.

    * no refs: working tree (including untracked files) vs HEAD
    * base only: working tree vs base
    * base and target: between two commits
    """
    if base is None and target is None:
        base = "HEAD" if has_commits(repo) else EMPTY_TREE
    check_ref(base)
    if target is not None:
        check_ref(target)
    range_args = [base] if target is None else [base, target]
    # Make untracked files visible to `git diff` without staging their content.
    if target is None:
        untracked = [f["path"] for f in status(repo)["files"] if f["status"] == "untracked"]
        if path:
            untracked = [u for u in untracked if u == path or u.startswith(path.rstrip("/") + "/")]
        if untracked:
            run(repo, "add", "--intent-to-add", "--", *untracked)
    args = ["diff", "-M", "--no-color", *range_args, "--"]
    args += [path] if path else ["."]
    args.append(":(exclude,glob)**/*.ipynb")
    files = _changed_files(repo, *range_args, path=path)
    patch = out(repo, *args)
    # Notebooks: diff a readable text form instead of raw JSON (outputs summarised).
    for f in files:
        if f["path"].endswith(".ipynb"):
            patch += _notebook_patch(repo, base, target, f["path"], f["orig_path"])
    return {"patch": patch, "files": files}


def _blob(repo: Path, ref: str, path: str) -> str | None:
    if ref == EMPTY_TREE:
        return None
    proc = run(repo, "show", f"{ref}:{path}", check=False)
    return proc.stdout if proc.returncode == 0 else None


def _notebook_patch(repo: Path, base: str, target: str | None, path: str, orig: str | None) -> str:
    import difflib

    from .notebooks import to_text

    old = _blob(repo, base, orig or path)
    if target is None:
        working = repo / path
        new = working.read_text(encoding="utf-8", errors="replace") if working.exists() else None
    else:
        new = _blob(repo, target, path)
    lines = list(difflib.unified_diff(to_text(old).splitlines(), to_text(new).splitlines(),
                                      f"a/{orig or path}", f"b/{path}", lineterm="", n=3))
    if not lines:
        return ""
    header = f"diff --git a/{orig or path} b/{path}\n"
    if old is None:
        header += "new file mode 100644\n"
    elif new is None:
        header += "deleted file mode 100644\n"
    return header + "\n".join(lines) + "\n"


def file_at(repo: Path, ref: str, path: str) -> str:
    check_ref(ref)
    return out(repo, "show", f"{ref}:{path}")


def discard(repo: Path, path: str) -> None:
    tracked = run(repo, "ls-files", "--error-unmatch", "--", path, check=False).returncode == 0
    in_head = has_commits(repo) and run(repo, "cat-file", "-e", f"HEAD:{path}", check=False).returncode == 0
    if in_head:
        run(repo, "checkout", "HEAD", "--", path)
    else:
        if tracked:
            run(repo, "rm", "--cached", "-q", "-f", "--", path)
        target = repo / path
        if target.is_file():
            target.unlink()


# ---------------------------------------------------------------- branches

def branches(repo: Path) -> dict:
    fmt = _US.join(["%(refname)", "%(refname:short)", "%(objectname:short)", "%(committerdate:iso-strict)",
                    "%(upstream:short)", "%(subject)"])
    local, remote = [], []
    for line in out(repo, "for-each-ref", f"--format={fmt}", "refs/heads", "refs/remotes").splitlines():
        full, short, sha, date, upstream, subject = line.split(_US)
        item = {"name": short, "sha": sha, "date": date, "upstream": upstream or None, "subject": subject}
        if full.startswith("refs/heads/"):
            local.append(item)
        elif not full.endswith("/HEAD"):
            remote.append(item)
    return {"current": current_branch(repo), "local": local, "remote": remote}


def create_branch(repo: Path, name: str, start: str | None = None, checkout: bool = True) -> None:
    check_ref(name, "branch name")
    if start:
        check_ref(start)
    run(repo, "check-ref-format", "--branch", name)
    if checkout:
        run(repo, "checkout", "-b", name, *([start] if start else []))
    else:
        run(repo, "branch", name, *([start] if start else []))


def checkout(repo: Path, name: str) -> None:
    check_ref(name, "branch name")
    # `git checkout` creates a local tracking branch automatically for remote names like
    # "feature" when "origin/feature" exists.
    if name.count("/") and run(repo, "rev-parse", "--verify", f"refs/remotes/{name}", check=False).returncode == 0:
        local = name.split("/", 1)[1]
        if run(repo, "rev-parse", "--verify", f"refs/heads/{local}", check=False).returncode != 0:
            run(repo, "checkout", "-b", local, "--track", name)
            return
        name = local
    run(repo, "checkout", name, "--")


def delete_branch(repo: Path, name: str, force: bool = False) -> None:
    check_ref(name, "branch name")
    run(repo, "branch", "-D" if force else "-d", name)


def _auto_merge_notebooks(repo: Path) -> list[str]:
    """Merge conflicted notebooks cell by cell; returns the notebooks merged automatically."""
    from . import nbmerge

    merged = []
    for path in status(repo)["conflicts"]:
        if not path.endswith(".ipynb"):
            continue
        v = conflict_versions(repo, path, with_notebook=False)
        result = nbmerge.merge(nbmerge.loads(v["base"]), nbmerge.loads(v["ours"]), nbmerge.loads(v["theirs"]))
        if result["conflicts"] == 0 and (v["ours"] or v["theirs"]):
            resolve(repo, path, nbmerge.compose(result))
            merged.append(path)
    return merged


def _finish_notebook_merge(repo: Path) -> list[str]:
    """Auto-merge conflicted notebooks; if nothing else conflicts, complete the merge commit."""
    if not is_merging(repo):
        return []
    auto = _auto_merge_notebooks(repo)
    if auto and not status(repo)["conflicts"]:
        run(repo, "commit", "--no-edit")
    return auto


def merge(repo: Path, name: str) -> dict:
    check_ref(name, "branch name")
    proc = run(repo, "merge", "--no-ff", "--no-edit", name, check=False)
    auto = _finish_notebook_merge(repo)
    st = status(repo)
    if proc.returncode != 0 and not st["conflicts"] and not auto:
        raise GitError((proc.stderr or proc.stdout).strip())
    return {"conflicts": st["conflicts"], "auto_merged": auto, "message": (proc.stdout or proc.stderr).strip()}


def abort_merge(repo: Path) -> None:
    run(repo, "merge", "--abort")


def conflict_versions(repo: Path, path: str, with_notebook: bool = True) -> dict:
    def stage(n: int) -> str | None:
        proc = run(repo, "show", f":{n}:{path}", check=False)
        return proc.stdout if proc.returncode == 0 else None

    working = repo / path
    versions = {
        "path": path,
        "base": stage(1),
        "ours": stage(2),
        "theirs": stage(3),
        "working": working.read_text(encoding="utf-8", errors="replace") if working.exists() else None,
    }
    if with_notebook and path.endswith(".ipynb"):
        from . import nbmerge
        versions["notebook"] = nbmerge.merge(nbmerge.loads(versions["base"]), nbmerge.loads(versions["ours"]),
                                             nbmerge.loads(versions["theirs"]))
    return versions


def resolve_notebook(repo: Path, path: str, choices: dict[str, str]) -> None:
    """Finish a notebook conflict with a choice per conflicting cell."""
    from . import nbmerge

    v = conflict_versions(repo, path, with_notebook=False)
    result = nbmerge.merge(nbmerge.loads(v["base"]), nbmerge.loads(v["ours"]), nbmerge.loads(v["theirs"]))
    try:
        resolve(repo, path, nbmerge.compose(result, choices))
    except ValueError as exc:
        raise GitError(str(exc)) from exc


def resolve(repo: Path, path: str, content: str | None) -> None:
    """Mark ``path`` resolved. ``content=None`` means the file should be deleted."""
    target = repo / path
    if content is None:
        run(repo, "rm", "-q", "-f", "--", path)
    else:
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content, encoding="utf-8")
        run(repo, "add", "--", path)


# ---------------------------------------------------------------- remotes

def remotes(repo: Path) -> list[dict]:
    names = out(repo, "remote").split()
    return [{"name": n, "url": remote_url(repo, n)} for n in names]


def add_remote(repo: Path, name: str, url: str) -> None:
    check_ref(name, "remote name")
    check_url(url)
    run(repo, "remote", "add", name, url)


def set_remote_url(repo: Path, name: str, url: str) -> None:
    check_ref(name, "remote name")
    check_url(url)
    run(repo, "remote", "set-url", name, url)


def remove_remote(repo: Path, name: str) -> None:
    check_ref(name, "remote name")
    run(repo, "remote", "remove", name)


def fetch(repo: Path, remote: str = "origin") -> str:
    check_ref(remote, "remote name")
    proc = run(repo, "fetch", "--prune", remote, extra_config=auth_config(repo, remote), timeout=300)
    return (proc.stderr or proc.stdout).strip()


def pull(repo: Path, remote: str = "origin", branch: str | None = None) -> dict:
    branch = branch or current_branch(repo)
    if not branch:
        raise GitError("Not on a branch.")
    check_ref(remote, "remote name")
    check_ref(branch, "branch name")
    proc = run(repo, "pull", "--no-rebase", "--no-edit", remote, branch,
               extra_config=auth_config(repo, remote), check=False, timeout=300)
    auto = _finish_notebook_merge(repo)
    st = status(repo)
    if proc.returncode != 0 and not st["conflicts"] and not auto:
        raise GitError((proc.stderr or proc.stdout).strip())
    if auto and not st["upstream"]:
        run(repo, "branch", f"--set-upstream-to={remote}/{branch}", check=False)
    # Track the remote branch so ahead/behind counts work.
    if proc.returncode == 0 and not st["upstream"]:
        run(repo, "branch", f"--set-upstream-to={remote}/{branch}", check=False)
    return {"conflicts": st["conflicts"], "auto_merged": auto, "message": (proc.stdout + proc.stderr).strip()}


def push(repo: Path, remote: str = "origin", branch: str | None = None) -> str:
    branch = branch or current_branch(repo)
    if not branch:
        raise GitError("Not on a branch.")
    check_ref(remote, "remote name")
    check_ref(branch, "branch name")
    proc = run(repo, "push", "-u", remote, branch, extra_config=auth_config(repo, remote), timeout=300)
    return (proc.stderr or proc.stdout).strip()
