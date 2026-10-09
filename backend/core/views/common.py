from django.shortcuts import get_object_or_404
from rest_framework import status
from rest_framework.response import Response
from rest_framework.views import exception_handler as drf_exception_handler

from core.models import Project
from core.services.bib import BibError
from core.services.envs import EnvError
from core.services.git import GitError
from core.services.kernels import KernelError
from core.services.jobs import JobError
from core.services.notebooks import NotebookError
from core.services.packaging import PackagingError
from core.services.pandoc import PandocError
from core.services.paths import PathError

ERROR_STATUS = {
    GitError: status.HTTP_409_CONFLICT,
    PathError: status.HTTP_400_BAD_REQUEST,
    PandocError: status.HTTP_422_UNPROCESSABLE_ENTITY,
    BibError: status.HTTP_400_BAD_REQUEST,
    NotebookError: status.HTTP_400_BAD_REQUEST,
    KernelError: status.HTTP_422_UNPROCESSABLE_ENTITY,
    EnvError: status.HTTP_422_UNPROCESSABLE_ENTITY,
    PackagingError: status.HTTP_400_BAD_REQUEST,
    JobError: status.HTTP_404_NOT_FOUND,
    FileExistsError: status.HTTP_409_CONFLICT,
    FileNotFoundError: status.HTTP_404_NOT_FOUND,
    PermissionError: status.HTTP_403_FORBIDDEN,
    IsADirectoryError: status.HTTP_400_BAD_REQUEST,
}


def exception_handler(exc, context):
    for cls, code in ERROR_STATUS.items():
        if isinstance(exc, cls):
            message = str(exc)
            if isinstance(exc, FileNotFoundError):
                message = "File not found."
            body = {"detail": message}
            if getattr(exc, "code", ""):
                body.update(code=exc.code, **getattr(exc, "extra", {}))
            return Response(body, status=code)
    return drf_exception_handler(exc, context)


def get_project(slug: str) -> Project:
    project = get_object_or_404(Project, slug=slug)
    if not project.path.exists():
        raise FileNotFoundError(project.path)
    return project


def require(data, *keys):
    missing = [k for k in keys if data.get(k) in (None, "")]
    if missing:
        raise PathError(f"Missing field(s): {', '.join(missing)}")
    return [data.get(k) for k in keys]
