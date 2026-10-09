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


@api_view(["GET"])
def kernel_events(request, slug):
    """Long poll: kernel messages after ``since`` (drives live widgets in the browser)."""
    _, path = _target(request, slug)
    since = int(request.query_params.get("since", 0))
    wait = min(float(request.query_params.get("wait", 20)), 25.0)
    return Response(kernels.events(slug, path, since, wait))


@api_view(["POST"])
def kernel_comm(request, slug):
    """Send a widget message (comm_open / comm_msg / comm_close) to the kernel."""
    _, path = _target(request, slug)
    d = request.data
    msg_id = kernels.send_comm(slug, path, d.get("msg_type", "comm_msg"), d.get("content") or {},
                               d.get("buffers") or [], d.get("metadata") or {}, d.get("msg_id") or None)
    return Response({"msg_id": msg_id})
