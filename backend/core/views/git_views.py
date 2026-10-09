from rest_framework.decorators import api_view
from rest_framework.response import Response

from core.services import git
from core.services.paths import safe_path

from .common import get_project, require


def _repo(slug):
    return get_project(slug).path


@api_view(["GET"])
def status(request, slug):
    return Response(git.status(_repo(slug)))


@api_view(["POST"])
def commit(request, slug):
    repo = _repo(slug)
    (message,) = require(request.data, "message")
    paths = request.data.get("paths") or None
    sha = git.commit(repo, message, paths)
    return Response({"sha": sha, "status": git.status(repo)}, status=201)


@api_view(["GET"])
def log(request, slug):
    q = request.query_params
    return Response(git.log(_repo(slug), ref=q.get("ref") or None, path=q.get("path") or None,
                            limit=min(int(q.get("limit", 50)), 500), skip=int(q.get("skip", 0))))


@api_view(["GET"])
def show(request, slug, sha):
    repo = _repo(slug)
    data = git.show(repo, sha)
    parent = data["parents"][0] if data["parents"] else git.EMPTY_TREE
    data["patch"] = git.diff(repo, parent, sha)["patch"]
    return Response(data)


@api_view(["GET"])
def diff(request, slug):
    q = request.query_params
    return Response(git.diff(_repo(slug), base=q.get("base") or None, target=q.get("target") or None,
                             path=q.get("path") or None))


@api_view(["GET"])
def file_at(request, slug):
    q = request.query_params
    repo = _repo(slug)
    ref, path = q.get("ref"), q.get("path")
    safe_path(repo, path)
    return Response({"ref": ref, "path": path, "content": git.file_at(repo, ref, path)})


@api_view(["POST"])
def restore_version(request, slug):
    """Copy a file's content from an older commit into the working tree."""
    repo = _repo(slug)
    ref, path = require(request.data, "ref", "path")
    target = safe_path(repo, path)
    content = git.file_at(repo, ref, path)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(content, encoding="utf-8", newline="\n")
    return Response({"path": path})


@api_view(["POST"])
def discard(request, slug):
    repo = _repo(slug)
    (path,) = require(request.data, "path")
    safe_path(repo, path)
    git.discard(repo, path)
    return Response(git.status(repo))


@api_view(["GET", "POST"])
def branches(request, slug):
    repo = _repo(slug)
    if request.method == "POST":
        (name,) = require(request.data, "name")
        git.create_branch(repo, name, request.data.get("start") or None,
                          checkout=request.data.get("checkout", True))
    return Response(git.branches(repo))


@api_view(["POST"])
def checkout(request, slug):
    repo = _repo(slug)
    (name,) = require(request.data, "name")
    git.checkout(repo, name)
    return Response(git.branches(repo))


@api_view(["POST"])
def delete_branch(request, slug):
    repo = _repo(slug)
    (name,) = require(request.data, "name")
    git.delete_branch(repo, name, force=bool(request.data.get("force")))
    return Response(git.branches(repo))


@api_view(["POST"])
def merge(request, slug):
    repo = _repo(slug)
    (name,) = require(request.data, "name")
    return Response(git.merge(repo, name))


@api_view(["POST"])
def merge_abort(request, slug):
    repo = _repo(slug)
    git.abort_merge(repo)
    return Response(git.status(repo))


@api_view(["GET", "POST"])
def conflict(request, slug):
    repo = _repo(slug)
    if request.method == "GET":
        path = request.query_params.get("path")
        safe_path(repo, path)
        return Response(git.conflict_versions(repo, path))
    (path,) = require(request.data, "path")
    safe_path(repo, path)
    content = None if request.data.get("delete") else request.data.get("content", "")
    git.resolve(repo, path, content)
    return Response(git.status(repo))


@api_view(["GET", "POST"])
def remotes(request, slug):
    repo = _repo(slug)
    if request.method == "POST":
        name, url = require(request.data, "name", "url")
        if any(r["name"] == name for r in git.remotes(repo)):
            git.set_remote_url(repo, name, url)
        else:
            git.add_remote(repo, name, url)
    return Response(git.remotes(repo))


@api_view(["DELETE"])
def remote_detail(request, slug, name):
    repo = _repo(slug)
    git.remove_remote(repo, name)
    return Response(git.remotes(repo))


@api_view(["POST"])
def fetch(request, slug):
    repo = _repo(slug)
    message = git.fetch(repo, request.data.get("remote", "origin"))
    return Response({"message": message, "status": git.status(repo)})


@api_view(["POST"])
def pull(request, slug):
    repo = _repo(slug)
    result = git.pull(repo, request.data.get("remote", "origin"), request.data.get("branch") or None)
    return Response({**result, "status": git.status(repo)})


@api_view(["POST"])
def push(request, slug):
    repo = _repo(slug)
    message = git.push(repo, request.data.get("remote", "origin"), request.data.get("branch") or None)
    return Response({"message": message, "status": git.status(repo)})
