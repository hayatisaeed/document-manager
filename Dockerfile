# ---------- 1. Build the React frontend
FROM node:22-bookworm-slim AS frontend
WORKDIR /app/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

# ---------- 2. Python app with git, pandoc and LaTeX
FROM python:3.12-slim-bookworm

ARG PANDOC_VERSION=3.6.4
ARG INSTALL_LATEX=true

RUN apt-get update \
 && apt-get install -y --no-install-recommends git openssh-client ca-certificates curl \
 && if [ "$INSTALL_LATEX" = "true" ]; then \
      apt-get install -y --no-install-recommends texlive-xetex texlive-latex-recommended \
        texlive-fonts-recommended texlive-latex-extra lmodern fonts-dejavu fonts-noto-core; \
    fi \
 && ARCH="$(dpkg --print-architecture)" \
 && curl -fsSL -o /tmp/pandoc.deb \
      "https://github.com/jgm/pandoc/releases/download/${PANDOC_VERSION}/pandoc-${PANDOC_VERSION}-1-${ARCH}.deb" \
 && dpkg -i /tmp/pandoc.deb && rm /tmp/pandoc.deb \
 && apt-get purge -y curl && apt-get autoremove -y && rm -rf /var/lib/apt/lists/*

WORKDIR /app/backend
COPY backend/requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt
COPY backend/ ./
COPY --from=frontend /app/frontend/dist /app/frontend/dist
COPY docker/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENV DM_DATA_DIR=/data \
    DM_FRONTEND_DIST=/app/frontend/dist \
    DM_DEBUG=0 \
    PYTHONUNBUFFERED=1

VOLUME ["/data"]
EXPOSE 8000
ENTRYPOINT ["/entrypoint.sh"]
