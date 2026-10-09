import shutil

from django.conf import settings
from django.utils import timezone
from rest_framework.decorators import api_view
from rest_framework.response import Response

from core.models import AppSettings, Credential, Project
from core.services import git, pandoc
from core.services import project_files as pf
from core.services.paths import PathError

from .common import get_project, require


def _summary(project: Project) -> dict:
    manifest = pf.read_manifest(project.path)
    try:
        branch = git.current_branch(project.path)
    except git.GitError:
        branch = None
    return {
        "slug": project.slug,
        "title": manifest.get("title") or project.slug,
        "subtitle": manifest.get("subtitle", ""),
        "kind": manifest.get("kind", "book"),
        "description": manifest.get("description", ""),
        "authors": manifest.get("authors", []),
        "branch": branch,
        "created_at": project.created_at,
        "last_opened": project.last_opened,
    }


def _unique_slug(title: str) -> str:
    base = pf.slugify(title)
    slug, n = base, 2
    while Project.objects.filter(slug=slug).exists() or (settings.PROJECTS_DIR / slug).exists():
        slug, n = f"{base}-{n}", n + 1
    return slug


@api_view(["GET", "POST"])
def project_list(request):
    if request.method == "GET":
        projects = [p for p in Project.objects.all() if p.path.exists()]
        return Response([_summary(p) for p in projects])

    data = request.data
    clone_url = (data.get("clone_url") or "").strip()
    if clone_url:
        title = data.get("title") or clone_url.rstrip("/").rsplit("/", 1)[-1].removesuffix(".git")
        slug = _unique_slug(title)
        dest = settings.PROJECTS_DIR / slug
        try:
            git.clone(clone_url, dest)
        except git.GitError:
            shutil.rmtree(dest, ignore_errors=True)
            raise
        pf.ensure_manifest(dest)
    else:
        (title,) = require(data, "title")
        kind = data.get("kind", "book")
        fmt = data.get("format", "markdown")
        if fmt not in pf.EXTENSIONS:
            raise PathError(f"Unknown format {fmt}")
        slug = _unique_slug(title)
        dest = settings.PROJECTS_DIR / slug
        git.init(dest)
        authors = data.get("authors") or ([AppSettings.load().author_name] if AppSettings.load().author_name else [])
        pf.scaffold(dest, title, kind, fmt, data.get("description", ""), authors)
        git.commit(dest, f"Create project: {title}")
    project = Project.objects.create(slug=slug, last_opened=timezone.now())
    return Response(_summary(project), status=201)


@api_view(["GET", "PATCH", "DELETE"])
def project_detail(request, slug):
    project = get_project(slug)
    if request.method == "GET":
        project.last_opened = timezone.now()
        project.save(update_fields=["last_opened"])
        return Response({**_summary(project), "manifest": pf.read_manifest(project.path)})
    if request.method == "PATCH":
        manifest = pf.read_manifest(project.path)
        for key in ("title", "subtitle", "authors", "kind", "description", "export", "language"):
            if key in request.data:
                manifest[key] = request.data[key]
        pf.write_manifest(project.path, manifest)
        return Response({**_summary(project), "manifest": manifest})
    # DELETE: unregister, and remove files only when explicitly asked.
    if request.query_params.get("delete_files") == "true":
        shutil.rmtree(project.path, ignore_errors=True)
    project.delete()
    return Response(status=204)


@api_view(["POST"])
def project_import(request):
    """Register a project folder that already exists inside the data directory."""
    (folder,) = require(request.data, "folder")
    path = settings.PROJECTS_DIR / folder
    if not path.is_dir() or "/" in folder or folder.startswith("."):
        raise PathError("Folder not found in the projects directory.")
    if not (path / ".git").exists():
        git.init(path)
    pf.ensure_manifest(path)
    project, _ = Project.objects.get_or_create(slug=folder)
    return Response(_summary(project), status=201)


@api_view(["GET"])
def unregistered_folders(request):
    known = set(Project.objects.values_list("slug", flat=True))
    folders = [p.name for p in settings.PROJECTS_DIR.iterdir()
               if p.is_dir() and p.name not in known and not p.name.startswith(".")]
    return Response(sorted(folders))


@api_view(["GET", "PUT"])
def app_settings(request):
    s = AppSettings.load()
    if request.method == "PUT":
        d = request.data
        s.author_name = d.get("author_name", s.author_name).strip()
        s.author_email = d.get("author_email", s.author_email).strip()
        if d.get("ui_language") in ("en", "fa"):
            s.ui_language = d["ui_language"]
        if d.get("theme") in ("system", "light", "dark"):
            s.theme = d["theme"]
        if d.get("calendar") in ("auto", "gregorian", "jalali"):
            s.calendar = d["calendar"]
        s.save()
    return Response({
        "author_name": s.author_name,
        "author_email": s.author_email,
        "ui_language": s.ui_language,
        "theme": s.theme,
        "calendar": s.calendar,
        "capabilities": pandoc.capabilities(),
        "projects_dir": str(settings.PROJECTS_DIR),
    })


def _cred(c: Credential) -> dict:
    return {"id": c.id, "host": c.host, "username": c.username,
            "token_preview": ("•" * 6 + c.token[-4:]) if len(c.token) > 4 else "••••"}


@api_view(["GET", "POST"])
def credential_list(request):
    if request.method == "POST":
        host, username, token = require(request.data, "host", "username", "token")
        host = host.strip().lower().removeprefix("https://").removeprefix("http://").split("/")[0]
        cred, _ = Credential.objects.update_or_create(host=host, defaults={"username": username.strip(),
                                                                              "token": token.strip()})
        return Response(_cred(cred), status=201)
    return Response([_cred(c) for c in Credential.objects.all()])


@api_view(["DELETE"])
def credential_detail(request, pk):
    Credential.objects.filter(pk=pk).delete()
    return Response(status=204)
