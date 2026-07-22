# Datagrunt Studio Backend

FastAPI sidecar. Datagrunt loads files; DuckDB owns transforms.

## Setup
    uv venv
    uv pip install -e ".[dev]"

## Run
    uv run uvicorn app.main:app --reload

## Test
    uv run pytest
