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


class Project(models.Model):
    """A registered project. Its content (and metadata) lives in a git repo on disk."""

    slug = models.SlugField(max_length=120, unique=True)
    created_at = models.DateTimeField(auto_now_add=True)
    last_opened = models.DateTimeField(null=True, blank=True)

    class Meta:
        ordering = ["-last_opened", "-created_at"]

    @property
    def path(self) -> Path:
        return settings.PROJECTS_DIR / self.slug
