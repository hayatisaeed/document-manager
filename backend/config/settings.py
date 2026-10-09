"""Django settings for Document Manager.

The app is designed to run locally (one user per instance). Collaboration
happens through git remotes, not through shared server accounts.
"""
import os
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent

DATA_DIR = Path(os.environ.get("DM_DATA_DIR", BASE_DIR.parent / "data")).resolve()
PROJECTS_DIR = DATA_DIR / "projects"
DATA_DIR.mkdir(parents=True, exist_ok=True)
PROJECTS_DIR.mkdir(parents=True, exist_ok=True)

# Fonts used for Persian text in PDF/HTML exports (Vazirmatn, SIL OFL).
FONTS_DIR = Path(os.environ.get("DM_FONTS_DIR", BASE_DIR / "core" / "fonts"))

# Built React app (copied here by the Docker build, or `npm run build`).
FRONTEND_DIST = Path(os.environ.get("DM_FRONTEND_DIST", BASE_DIR.parent / "frontend" / "dist"))

SECRET_KEY = os.environ.get("DM_SECRET_KEY", "dev-only-insecure-key-change-me")
DEBUG = os.environ.get("DM_DEBUG", "1") == "1"
ALLOWED_HOSTS = os.environ.get("DM_ALLOWED_HOSTS", "localhost,127.0.0.1,0.0.0.0").split(",")

INSTALLED_APPS = [
    "django.contrib.contenttypes",
    "django.contrib.staticfiles",
    "corsheaders",
    "rest_framework",
    "core",
]

MIDDLEWARE = [
    "django.middleware.security.SecurityMiddleware",
    "whitenoise.middleware.WhiteNoiseMiddleware",
    "corsheaders.middleware.CorsMiddleware",
    "django.middleware.common.CommonMiddleware",
    "core.middleware.RequireClientHeaderMiddleware",
    "django.middleware.clickjacking.XFrameOptionsMiddleware",
]

# Allow PDF attachments to be shown in an <iframe> from the same origin.
X_FRAME_OPTIONS = "SAMEORIGIN"

ROOT_URLCONF = "config.urls"

TEMPLATES = [
    {
        "BACKEND": "django.template.backends.django.DjangoTemplates",
        "DIRS": [],
        "APP_DIRS": False,
        "OPTIONS": {"context_processors": []},
    }
]

WSGI_APPLICATION = "config.wsgi.application"

DATABASES = {
    "default": {
        "ENGINE": "django.db.backends.sqlite3",
        "NAME": DATA_DIR / "db.sqlite3",
    }
}

LANGUAGE_CODE = "en-us"
TIME_ZONE = "UTC"
USE_I18N = False
USE_TZ = True

STATIC_URL = "/static/"
STATIC_ROOT = DATA_DIR / "static"
STATIC_ROOT.mkdir(parents=True, exist_ok=True)
WHITENOISE_ROOT = FRONTEND_DIST if FRONTEND_DIST.exists() else None

DEFAULT_AUTO_FIELD = "django.db.models.BigAutoField"

DATA_UPLOAD_MAX_MEMORY_SIZE = 50 * 1024 * 1024
FILE_UPLOAD_MAX_MEMORY_SIZE = 50 * 1024 * 1024

REST_FRAMEWORK = {
    "DEFAULT_AUTHENTICATION_CLASSES": [],
    "DEFAULT_PERMISSION_CLASSES": ["rest_framework.permissions.AllowAny"],
    "UNAUTHENTICATED_USER": None,
    "EXCEPTION_HANDLER": "core.views.common.exception_handler",
}

# Vite dev server.
CORS_ALLOWED_ORIGINS = ["http://localhost:5173", "http://127.0.0.1:5173"]
CORS_ALLOW_HEADERS = ["content-type", "x-dm-client"]
