# Build stage: resolve and install dependencies into a standalone venv.
FROM ghcr.io/astral-sh/uv:python3.12-bookworm-slim AS builder

ENV UV_PROJECT_ENVIRONMENT=/opt/venv \
    UV_LINK_MODE=copy \
    UV_PYTHON_DOWNLOADS=never

WORKDIR /build
# uv.lock is committed (app convention, #18); --frozen fails loudly if it
# is missing or stale.
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev --no-install-project

# Runtime stage: venv + application code only.
FROM python:3.12-slim-bookworm

# tesseract-ocr is the system binary pytesseract shells out to (used by
# datagrunt[pdf] to OCR scanned PDFs). The slim base does not include it.
RUN apt-get update \
    && apt-get install --no-install-recommends -y tesseract-ocr \
    && rm -rf /var/lib/apt/lists/*

RUN useradd --create-home --uid 1001 studio \
    && mkdir -p /data \
    && chown studio:studio /data

ENV PATH="/opt/venv/bin:$PATH" \
    PYTHONUNBUFFERED=1 \
    STUDIO_DATA_DIR=/data

WORKDIR /srv
COPY --from=builder /opt/venv /opt/venv
# session.py expects seed/ to be a sibling of app/.
COPY app ./app
COPY seed ./seed

USER studio
VOLUME /data
EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/health')"

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
