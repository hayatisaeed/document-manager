import mimetypes
import re

from django.conf import settings

from django.http import FileResponse
from rest_framework.decorators import api_view, parser_classes
from rest_framework.parsers import FormParser, JSONParser, MultiPartParser
from rest_framework.response import Response

from core.services import bib, pandoc
from core.services import project_files as pf
from core.services.paths import PathError, doc_format, safe_path

from .common import get_project, require


@api_view(["GET"])
def tree(request, slug):
    project = get_project(slug)
    return Response(pf.tree(project.path))


@api_view(["GET", "PUT", "POST", "DELETE"])
def file_detail(request, slug):
    """GET/PUT/DELETE ?path=...  POST creates a new file."""
    project = get_project(slug)
    root = project.path

    if request.method == "POST":
        (path,) = require(request.data, "path")
        target = safe_path(root, path)
        if target.exists():
            raise FileExistsError(f"{path} already exists")
        if request.data.get("type") == "dir":
            target.mkdir(parents=True)
            (target / ".gitkeep").touch()
            return Response({"path": path}, status=201)
        title = request.data.get("title") or re.sub(r"^\d+[-_ ]*", "", target.stem).replace("-", " ").replace(
            "_", " ").strip().title() or target.stem
        fmt = doc_format(path)
        content = request.data.get("content")
        if content is None:
            content = pf.starter_content(fmt, title) if fmt else ""
        pf.write_text(root, path, content)
        manifest = pf.read_manifest(root)
        manifest["files"][path] = {"title": title, "status": "draft" if fmt else "idea",
                                   "tags": request.data.get("tags") or [], "target_words": 0}
        if request.data.get("add_to_manuscript") and fmt:
            manifest["manuscript"].append(path)
        pf.write_manifest(root, manifest)
        return Response({"path": path}, status=201)

    path = request.query_params.get("path")
    if request.method == "GET":
        target = safe_path(root, path)
        if target.is_dir():
            raise IsADirectoryError(f"{path} is a directory")
        return Response({"path": path, "content": pf.read_text(root, path), "format": doc_format(path)})
    if request.method == "PUT":
        content = request.data.get("content")
        if content is None:
            raise PathError("content is required")
        pf.write_text(root, path, content)
        return Response({"path": path, "words": pf.word_count(content, doc_format(path))})
    pf.delete(root, path)
    return Response(status=204)


@api_view(["POST"])
def move_file(request, slug):
    project = get_project(slug)
    src, dest = require(request.data, "from", "to")
    pf.move(project.path, src, dest)
    return Response({"path": dest})


@api_view(["POST"])
@parser_classes([MultiPartParser, FormParser])
def upload(request, slug):
    project = get_project(slug)
    folder = (request.data.get("folder") or "attachments").strip("/")
    saved = []
    for f in request.FILES.getlist("files"):
        name = f.name.replace("\\", "/").rsplit("/", 1)[-1]
        target = safe_path(project.path, f"{folder}/{name}")
        target.parent.mkdir(parents=True, exist_ok=True)
        with open(target, "wb") as out:
            for chunk in f.chunks():
                out.write(chunk)
        saved.append(f"{folder}/{name}")
    return Response({"paths": saved}, status=201)


@api_view(["GET"])
def raw(request, slug):
    project = get_project(slug)
    target = safe_path(project.path, request.query_params.get("path"))
    if not target.is_file():
        raise FileNotFoundError(target)
    mime, _ = mimetypes.guess_type(target.name)
    # Serve HTML as plain text so uploaded files cannot run scripts in the app's origin.
    if mime in ("text/html", "image/svg+xml", "application/xhtml+xml"):
        mime = "text/plain"
    response = FileResponse(open(target, "rb"), content_type=mime or "application/octet-stream")
    response["X-Content-Type-Options"] = "nosniff"
    if request.query_params.get("download"):
        response["Content-Disposition"] = f'attachment; filename="{target.name}"'
    return response


@api_view(["GET", "PUT"])
@parser_classes([JSONParser])
def manifest(request, slug):
    project = get_project(slug)
    if request.method == "PUT":
        data = request.data
        current = pf.read_manifest(project.path)
        if "manuscript" in data:
            for p in data["manuscript"]:
                safe_path(project.path, p)
            current["manuscript"] = list(dict.fromkeys(data["manuscript"]))
        if "files" in data:
            current["files"] = data["files"]
        pf.write_manifest(project.path, current)
        return Response(current)
    return Response(pf.read_manifest(project.path))


@api_view(["GET"])
def search(request, slug):
    project = get_project(slug)
    return Response(pf.search(project.path, request.query_params.get("q", "")))


@api_view(["GET"])
def stats(request, slug):
    return Response(pf.stats(get_project(slug).path))


@api_view(["POST"])
def preview(request, slug):
    project = get_project(slug)
    path = request.data.get("path")
    safe_path(project.path, path)
    html = pandoc.preview(project.path, slug, path, request.data.get("content", ""),
                          theme=request.data.get("theme", "light"))
    return Response({"html": html})


@api_view(["POST"])
def export(request, slug):
    project = get_project(slug)
    fmt = request.data.get("format", "pdf")
    paths = request.data.get("paths") or None
    for p in paths or []:
        safe_path(project.path, p)
    output = pandoc.export(project.path, fmt, paths, theme=request.data.get("theme") or None)
    response = FileResponse(open(output, "rb"), content_type=pandoc.EXPORT_FORMATS[fmt]["mime"])
    response["Content-Disposition"] = f'attachment; filename="{output.name}"'
    return response


@api_view(["GET", "POST"])
def references(request, slug):
    project = get_project(slug)
    if request.method == "POST":
        if request.data.get("doi"):
            text = bib.fetch_doi(request.data["doi"])
        else:
            (text,) = require(request.data, "bibtex")
        keys = bib.add(project.path, text, replace=bool(request.data.get("replace")))
        return Response({"keys": keys}, status=201)
    return Response(bib.entries(project.path))


@api_view(["GET", "PUT", "DELETE"])
def reference_detail(request, slug, key):
    project = get_project(slug)
    if request.method == "DELETE":
        bib.remove(project.path, key)
        return Response(status=204)
    if request.method == "PUT":
        (text,) = require(request.data, "bibtex")
        bib.update(project.path, key, text)
    return Response({"key": key, "bibtex": bib.raw_entry(project.path, key)})


@api_view(["GET"])
def cite(request, slug):
    keys = [k for k in request.query_params.get("keys", "").split(",") if k]
    fmt = request.query_params.get("fmt", "markdown")
    return Response({"markup": bib.citation_markup(fmt, keys)})


FONT_FILES = {"Vazirmatn-Regular.ttf", "Vazirmatn-Bold.ttf", "Vazir-Code.ttf"}


@api_view(["GET"])
def font(request, name):
    """Fonts for the preview iframe (sandboxed, so it needs CORS to load them)."""
    if name not in FONT_FILES:
        raise FileNotFoundError(name)
    response = FileResponse(open(settings.FONTS_DIR / name, "rb"), content_type="font/ttf")
    response["Access-Control-Allow-Origin"] = "*"
    response["Cache-Control"] = "max-age=86400"
    return response
