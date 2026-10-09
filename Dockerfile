# ---------- 1. Build the React frontend
FROM node:22-bookworm-slim AS frontend
# Optional npm registry mirror, e.g. --build-arg NPM_REGISTRY=https://registry.npmmirror.com
ARG NPM_REGISTRY=""
WORKDIR /app/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci ${NPM_REGISTRY:+--registry="$NPM_REGISTRY"}
COPY frontend/ ./
RUN npm run build

# ---------- 2. Python app with git, pandoc and LaTeX
FROM python:3.12-slim-bookworm

ARG PANDOC_VERSION=3.6.4
ARG INSTALL_LATEX=true
ARG INSTALL_SCIENCE=true
# Optional PyPI mirror for building the image, e.g. https://mirror-pypi.runflare.com/simple
ARG PIP_INDEX_URL=""

RUN apt-get update \
 && apt-get install -y --no-install-recommends git openssh-client ca-certificates curl \
 && if [ "$INSTALL_LATEX" = "true" ]; then \
      apt-get install -y --no-install-recommends texlive-luatex texlive-xetex texlive-latex-recommended \
        texlive-fonts-recommended texlive-latex-extra texlive-pictures texlive-lang-arabic lmodern; \
    fi \
 && ARCH="$(dpkg --print-architecture)" \
 && curl -fsSL -o /tmp/pandoc.deb \
      "https://github.com/jgm/pandoc/releases/download/${PANDOC_VERSION}/pandoc-${PANDOC_VERSION}-1-${ARCH}.deb" \
 && dpkg -i /tmp/pandoc.deb && rm /tmp/pandoc.deb \
 && apt-get purge -y curl && apt-get autoremove -y && rm -rf /var/lib/apt/lists/*

WORKDIR /app/backend
COPY backend/requirements.txt backend/requirements-science.txt ./
RUN INDEX="${PIP_INDEX_URL:+--index-url=$PIP_INDEX_URL}" \
 && pip install --no-cache-dir $INDEX -r requirements.txt \
 && if [ "$INSTALL_SCIENCE" = "true" ]; then pip install --no-cache-dir $INDEX -r requirements-science.txt; fi
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
