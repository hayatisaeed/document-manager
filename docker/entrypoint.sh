#!/bin/sh
set -e

# Generate a persistent secret key on first start.
if [ -z "$DM_SECRET_KEY" ]; then
  if [ ! -f /data/.secret_key ]; then
    mkdir -p /data
    python -c "import secrets; print(secrets.token_urlsafe(50))" > /data/.secret_key
  fi
  DM_SECRET_KEY="$(cat /data/.secret_key)"
  export DM_SECRET_KEY
fi

python manage.py migrate --noinput

# Let git use SSH keys mounted at /ssh (read-only) without touching the host's files.
if [ -d /ssh ]; then
  mkdir -p /root/.ssh
  cp -r /ssh/. /root/.ssh/ 2>/dev/null || true
  chmod 700 /root/.ssh
  chmod 600 /root/.ssh/* 2>/dev/null || true
fi

# A single process (with threads): Jupyter kernels for notebooks live in it.
exec waitress-serve --listen=0.0.0.0:8000 --threads=8 --channel-timeout=3600 \
  config.wsgi:application
