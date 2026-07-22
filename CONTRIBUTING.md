# Contributing to Datagrunt Studio

Thanks for your interest in contributing! This document covers how to set up a development environment, the workflow we use, and the gates every change must pass.

## Development setup

Prerequisites: [uv](https://docs.astral.sh/uv/) (all Python work goes through uv — never plain `pip`/`python`), Node.js 22+, and `tesseract` if you want to run the PDF OCR tests (`brew install tesseract` on macOS).

```bash
# Backend (FastAPI + DuckDB) — installs the exact pinned tree from the committed lock
cd backend
uv sync --extra dev

# Frontend (Next.js) — installs the exact pinned tree from package-lock.json
cd ..
npm ci
```

Run the dev servers with `npm run dev` (frontend) and `cd backend && uv run uvicorn app.main:app --reload` (backend, port 8000).

## Lock files

Studio is an application: `package-lock.json` and `backend/uv.lock` are **committed** so every contributor and CI build the same dependency tree. If your change touches dependencies, update the relevant lock file in the same PR (`uv lock` in `backend/`, `npm install` at the root) — CI installs with `uv sync --frozen` / `npm ci` and fails on a stale lock.

## Workflow

1. **Open an issue first** for any enhancement, bug, or optimization, with appropriate labels.
2. **Branch** as `<type>/<kebab-case>` — `feature/…`, `fix/…`, `refactor/…`, `perf/…`, `docs/…`, `chore/…`. Never commit to `main` directly. (Exception: the maintainer may push documentation/README-only changes straight to `main`; all source-code changes go through a PR with green CI, no exceptions.)
3. **Write tests first** — TDD: a failing test, then the implementation.
4. **Open a PR** referencing the issue (`Closes #<n>`). PRs are squash-merged after CI is green and maintainer review.

## Test gates — all must pass before merge

```bash
cd backend && uv run pytest -q
cd backend && uv run ruff check app tests && uv run ruff format --check .
npm test
npm run lint
npm run build   # when build-affecting files changed (config, deps, new routes)
```

## Keep PRs clean

No dev/test/benchmark/scratch cruft in the diff. Dev scripts go in `scripts/`. Don't commit non-documentation markdown (working notes, review scratch). AI-assistant and editor tool artifacts (`.claude/`, `.cursor/`, `.vscode/`, …) are gitignored and stay local.

## Reporting security issues

Please do not open public issues for vulnerabilities — see [SECURITY.md](SECURITY.md).
