from rest_framework.decorators import api_view
from rest_framework.response import Response

from core.models import NotebookKernel
from core.services import envs, kernels
from core.services.paths import PathError, safe_path

from .common import get_project


def _target(request, slug):
    project = get_project(slug)
    path = request.data.get("path") if request.method == "POST" else request.query_params.get("path")
    if not path or not path.endswith(".ipynb"):
        raise PathError("A notebook path (.ipynb) is required.")
    safe_path(project.path, path)
    return project, path


def _resolve(project, path) -> tuple[str, str]:
    """The kernel a notebook uses: its own choice, else the project's environment, else the app's."""
    chosen = NotebookKernel.objects.filter(project=project, path=path).values_list("kernel", flat=True).first()
    if chosen:
        return chosen, "notebook"
    if project.env_path:
        env = envs.env_by_path(project.env_path)
        if env:
            return env["kernel"], "project"
    return envs.app_env()["kernel"], "app"


def _status(project, path) -> dict:
    kernel, source = _resolve(project, path)
    return {**kernels.status(project.slug, path), "selected": kernel, "selected_source": source}


@api_view(["GET"])
def kernel_specs(request):
    """Kernels a notebook can use: Python environments, then other installed Jupyter kernels."""
    items = [{"kernel": e["kernel"], "id": e["id"], "name": e["name"], "kind": e["kind"],
              "python_version": e["python_version"], "has_ipykernel": e["has_ipykernel"]} for e in envs.list_envs()]
    return Response({"available": kernels.available(), "specs": kernels.specs(), "envs": items})


@api_view(["GET"])
def kernel_status(request, slug):
    project, path = _target(request, slug)
    return Response(_status(project, path))


@api_view(["POST"])
def kernel_start(request, slug):
    project, path = _target(request, slug)
    if "kernel" in request.data:
        # An explicit choice is remembered for this notebook; "" goes back to the default.
        kernel = request.data.get("kernel") or ""
        if kernel:
            NotebookKernel.objects.update_or_create(project=project, path=path, defaults={"kernel": kernel})
        else:
            NotebookKernel.objects.filter(project=project, path=path).delete()
    kernels.start(slug, project.path, path, _resolve(project, path)[0])
    return Response(_status(project, path))


@api_view(["POST"])
def kernel_execute(request, slug):
    project, path = _target(request, slug)
    code = request.data.get("code") or ""
    return Response(kernels.execute(slug, project.path, path, code, kernel_name=_resolve(project, path)[0]))


@api_view(["POST"])
def kernel_interrupt(request, slug):
    project, path = _target(request, slug)
    kernels.interrupt(slug, path)
    return Response(_status(project, path))


@api_view(["POST"])
def kernel_restart(request, slug):
    project, path = _target(request, slug)
    kernels.restart(slug, project.path, path, _resolve(project, path)[0])
    return Response(_status(project, path))


@api_view(["POST"])
def kernel_shutdown(request, slug):
    project, path = _target(request, slug)
    kernels.shutdown(slug, path)
    return Response(_status(project, path))


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
