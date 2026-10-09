from rest_framework.decorators import api_view
from rest_framework.response import Response

from core.services import kernels
from core.services.paths import PathError, safe_path

from .common import get_project


def _target(request, slug):
    project = get_project(slug)
    path = request.data.get("path") if request.method == "POST" else request.query_params.get("path")
    if not path or not path.endswith(".ipynb"):
        raise PathError("A notebook path (.ipynb) is required.")
    safe_path(project.path, path)
    return project, path


@api_view(["GET"])
def kernel_specs(request):
    return Response({"available": kernels.available(), "specs": kernels.specs()})


@api_view(["GET"])
def kernel_status(request, slug):
    _, path = _target(request, slug)
    return Response(kernels.status(slug, path))


@api_view(["POST"])
def kernel_start(request, slug):
    project, path = _target(request, slug)
    return Response(kernels.start(slug, project.path, path, request.data.get("kernel") or None))


@api_view(["POST"])
def kernel_execute(request, slug):
    project, path = _target(request, slug)
    code = request.data.get("code") or ""
    return Response(kernels.execute(slug, project.path, path, code))


@api_view(["POST"])
def kernel_interrupt(request, slug):
    _, path = _target(request, slug)
    kernels.interrupt(slug, path)
    return Response(kernels.status(slug, path))


@api_view(["POST"])
def kernel_restart(request, slug):
    project, path = _target(request, slug)
    return Response(kernels.restart(slug, project.path, path))


@api_view(["POST"])
def kernel_shutdown(request, slug):
    _, path = _target(request, slug)
    kernels.shutdown(slug, path)
    return Response(kernels.status(slug, path))
