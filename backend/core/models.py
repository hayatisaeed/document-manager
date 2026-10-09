from pathlib import Path

from django.conf import settings
from django.db import models


class AppSettings(models.Model):
    """Singleton holding the local user's git identity."""

    author_name = models.CharField(max_length=200, blank=True, default="")
    author_email = models.CharField(max_length=200, blank=True, default="")
    # Interface preferences.
    ui_language = models.CharField(max_length=8, default="en")  # en | fa
    theme = models.CharField(max_length=8, default="system")  # system | light | dark
    calendar = models.CharField(max_length=10, default="auto")  # auto | gregorian | jalali
    # Package sources (PyPI index, conda channels, proxy) for pip/conda run by the app.
    # See core.services.packaging.normalize_config for the keys.
    package_config = models.JSONField(default=dict, blank=True)
    # conda executable chosen by the user when it is not found automatically.
    conda_path = models.CharField(max_length=1024, blank=True, default="")

    @classmethod
    def load(cls) -> "AppSettings":
        obj, _ = cls.objects.get_or_create(pk=1)
        return obj


class Credential(models.Model):
    """HTTPS credential (personal access token) for a git host such as github.com."""

    host = models.CharField(max_length=255, unique=True)
    username = models.CharField(max_length=255)
    token = models.CharField(max_length=1024)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["host"]


class PythonEnv(models.Model):
    """A Python environment the app created or the user added by path.

    conda environments are also discovered through ``conda env list``, so they
    only need a row when the app created them.
    """

    path = models.CharField(max_length=1024, unique=True)
    kind = models.CharField(max_length=8)  # venv | conda
    created_by_app = models.BooleanField(default=False)
    added_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["path"]


class Project(models.Model):
    """A registered project. Its content (and metadata) lives in a git repo on disk."""

    slug = models.SlugField(max_length=120, unique=True)
    created_at = models.DateTimeField(auto_now_add=True)
    last_opened = models.DateTimeField(null=True, blank=True)
    # Python environment (prefix path) for this project's notebooks on this computer.
    # Not stored in the repository: paths differ between collaborators.
    env_path = models.CharField(max_length=1024, blank=True, default="")

    class Meta:
        ordering = ["-last_opened", "-created_at"]

    @property
    def path(self) -> Path:
        return settings.PROJECTS_DIR / self.slug


class NotebookKernel(models.Model):
    """The kernel chosen for one notebook on this computer (overrides the project's environment)."""

    project = models.ForeignKey(Project, on_delete=models.CASCADE, related_name="notebook_kernels")
    path = models.CharField(max_length=1024)
    kernel = models.CharField(max_length=255)

    class Meta:
        unique_together = [("project", "path")]
