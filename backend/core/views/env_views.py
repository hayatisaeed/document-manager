from pathlib import Path

from rest_framework.decorators import api_view
from rest_framework.response import Response

from core.models import AppSettings
from core.services import envs, jobs, kernels, packaging
from core.services import project_files as pf

from .common import get_project, require


def _conda_summary(refresh=False) -> dict | None:
    info = envs.conda_info(refresh)
    if not info:
        return None
    return {"exe": info["exe"], "version": info["version"], "mamba": bool(info["mamba"]),
            "root_prefix": info["root_prefix"]}


def _job(job: jobs.Job | None, status=202):
    return Response(job.summary(0) if job else None, status=status if job else 204)


@api_view(["GET"])
def env_list(request):
    refresh = request.query_params.get("refresh") == "1"
    conda = _conda_summary(refresh)
    items = envs.list_envs(refresh=refresh)
    for e in items:
        e["in_use"] = kernels.in_use(e["kernel"])
    return Response({"envs": items, "conda": conda, "conda_path": AppSettings.load().conda_path,
                     "envs_dir": str(envs.settings.ENVS_DIR)})


@api_view(["POST"])
def env_register(request):
    (path,) = require(request.data, "path")
    return Response(envs.register(path), status=201)


@api_view(["POST"])
def env_create(request):
    d = request.data
    kind, name = require(d, "kind", "name")
    packages = d.get("packages") or None
    if kind == "conda":
        job = envs.create_conda(name, d.get("python_version", ""), packages)
    elif kind == "venv":
        job = envs.create_venv(name, d.get("base_python", ""), packages)
    else:
        raise envs.EnvError("kind must be conda or venv")
    return _job(job)


@api_view(["DELETE"])
def env_detail(request, env_id):
    env = envs.get_env(env_id)
    delete_files = request.query_params.get("delete_files") == "true"
    return _job(envs.delete_env(env, delete_files, kernels.in_use(env["kernel"])))


@api_view(["GET", "POST"])
def env_packages(request, env_id):
    env = envs.get_env(env_id)
    if request.method == "GET":
        return Response({"env": env, "packages": envs.list_packages(env)})
    d = request.data
    action = d.get("action", "install")
    if action not in ("install", "upgrade", "uninstall"):
        raise envs.EnvError("Unknown action.")
    manager = d.get("manager") or "pip"
    return _job(envs.package_job(env, action, d.get("packages"), manager))


@api_view(["GET"])
def package_lookup(request):
    name = request.query_params.get("name", "")
    if request.query_params.get("manager") == "conda":
        return Response({"results": envs.search_conda(name)})
    found = packaging.lookup_pip(name)
    return Response({"results": [{"name": found["name"], "versions": found["versions"]}] if found["found"] else [],
                     "index": found["index"]})


@api_view(["GET", "PUT"])
def package_sources(request):
    s = AppSettings.load()
    if request.method == "PUT":
        packaging.save_config(request.data.get("config") or {})
        if "conda_path" in request.data:
            s.conda_path = (request.data.get("conda_path") or "").strip()
            s.save(update_fields=["conda_path"])
            envs.conda_info(refresh=True)
    return Response({"config": packaging.get_config(), "conda_path": AppSettings.load().conda_path,
                     "presets": {"pip": packaging.PIP_PRESETS, "conda": packaging.CONDA_PRESETS}})


@api_view(["POST"])
def package_source_test(request):
    kind, url = require(request.data, "kind", "url")
    return Response(packaging.test_source(kind, url))


@api_view(["GET"])
def job_list(request):
    return Response([j.summary() for j in jobs.all_jobs()])


@api_view(["GET"])
def job_detail(request, job_id):
    since = int(request.query_params.get("since", 0))
    return Response(jobs.get(job_id).summary(since))


@api_view(["POST"])
def job_cancel(request, job_id):
    job = jobs.get(job_id)
    job.cancel()
    return Response(job.summary())


# ---------------------------------------------------------------- per project

def _project_env(project) -> dict:
    env = envs.env_by_path(project.env_path) if project.env_path else None
    return {"env": env, "env_path": project.env_path, "missing": bool(project.env_path and not env),
            "default": envs.app_env(), "files": envs.project_env_files(project.path)}


@api_view(["GET", "PUT"])
def project_env(request, slug):
    project = get_project(slug)
    if request.method == "PUT":
        env_id = request.data.get("env_id")
        project.env_path = envs.get_env(env_id)["path"] if env_id else ""
        project.save(update_fields=["env_path"])
    return Response(_project_env(project))


@api_view(["POST"])
def project_env_export(request, slug):
    project = get_project(slug)
    env_id = request.data.get("env_id")
    env = envs.get_env(env_id) if env_id else (envs.env_by_path(project.env_path) if project.env_path else None)
    if not env:
        raise envs.EnvError("Choose the project's environment first.")
    title = pf.read_manifest(project.path).get("title") or slug
    written = envs.export_env_file(env, project.path, slug if not title.isascii() else title)
    return Response({"file": written, **_project_env(project)})


@api_view(["POST"])
def project_env_create(request, slug):
    """Create an environment from the project's environment.yml / requirements.txt and use it."""
    project = get_project(slug)
    kind, name = require(request.data, "kind", "name")

    def bind(prefix: Path):
        project.env_path = str(prefix)
        project.save(update_fields=["env_path"])

    if kind == "conda":
        source = project.path / envs.ENVIRONMENT_YML
        if not source.is_file():
            raise envs.EnvError("This project has no environment.yml.")
        job = envs.create_conda(name, environment_file=source, on_created=bind)
    else:
        source = project.path / envs.REQUIREMENTS
        if not source.is_file():
            raise envs.EnvError("This project has no requirements.txt.")
        job = envs.create_venv(name, request.data.get("base_python", ""), requirements=source, on_created=bind)
    return _job(job)
