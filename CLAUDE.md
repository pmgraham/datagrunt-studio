# CLAUDE.md — the datagrunt-studio playbook

Project-specific guidance for Claude Code (in addition to the global `~/.claude/CLAUDE.md` clean-code standards). This file is the source of truth for **how we work on datagrunt-studio**. When asked to do something "the usual way" / "per the usual", follow this. It mirrors the datagrunt repo's playbook, adapted for this app.

Datagrunt Studio is a web UI for exploring, cleaning, and joining structured data files: a **Next.js frontend** (`app/`, `components/`, `lib/`) talking through `app/api/*` proxy routes to a **FastAPI backend sidecar** (`backend/app/`) that wraps the datagrunt library and DuckDB.

---

## First principles (non-negotiable)

- **Datagrunt loads losslessly; Studio transforms.** The datagrunt library's job is lossless load/parse. All transforms, type conversion, and cleansing live in Studio's DuckDB layer (`backend/app/query_engine.py` + `sql_builder.py`). Never push app-specific transform logic down into the datagrunt library.
- **Never change the datagrunt library from this repo.** If a Studio feature seems to need a datagrunt change, file an issue on the datagrunt repo and design around it (or wait for release). Bumping the pinned `datagrunt` version in `backend/pyproject.toml` is fine.
- **The backend is a single-user local sidecar.** Loopback-only assumptions (no auth, session-scoped DuckDB file) are deliberate; don't add multi-tenant machinery speculatively — but never leak server filesystem paths into API error detail.

---

## The workflow ("the usual")

For any substantive change, follow this end-to-end. (Trivial 1–2 line fixes may skip the formal plan doc but still get tests, a PR, and CI.)

1. **Track it as a labeled GitHub issue, up front.** Every enhancement/optimization/bug gets a `gh issue create --label <…>` *before* implementation. Labels: `performance`, `code-quality`, `bug`, `documentation`, `security`, `enhancement`. Apply multiple when it spans categories. If expanded scope is discovered mid-work, log it as its own issue and defer it — don't balloon the current PR.
2. **Branch as `<type>/<kebab-case>`** — `feature/…`, `refactor/…`, `perf/…`, `fix/…`, `docs/…`, `chore/…`. Never commit source code straight to `main` — all source changes go through a PR with green CI. Sole exception (branch protection permits it via admin bypass): the maintainer may push **documentation/README-only** changes directly to `main`.
3. **Plan** with the `superpowers:writing-plans` skill (save under the gitignored `docs/superpowers/plans/`).
4. **Implement via `superpowers:subagent-driven-development`:** a fresh implementer subagent per task (TDD — failing test first), then a per-task spec+quality review; fix Critical/Important findings before moving on.
5. **Final whole-branch review** (most capable model) for non-trivial changes; address findings.
6. **Open a PR** with a clear body and `Closes #<issue>`. Merge (squash, delete branch) **only after CI is green and with the maintainer's express consent**, then sync `main`.

### Test gates — all must pass before merge
- `cd backend && uv run pytest -q`
- `cd backend && uv run ruff check app tests && uv run ruff format --check .`
- `npm test` (vitest)
- `npm run lint` (eslint)
- `npm run build` when frontend build-affecting files changed (config, deps, new routes)

### Hygiene
- Use **`uv`** for all Python package/env work (never plain `pip`/`python`).
- **Never run `npm run build` while the dev servers are up** (it clobbers `.next/`); dev servers live in `.claude/launch.json` (`backend`, `frontend`) — a local, untracked file (the whole `.claude/` dir stays local; see #20).
- **Lock files are committed** (`package-lock.json`, `backend/uv.lock`) — Studio is an application, so contributors and CI build the exact same pinned dependency tree (`npm ci` / `uv sync --frozen`); update the lock in the same PR as any dependency change (#18). (datagrunt, a library, keeps its lock files untracked — don't copy this convention there.)
- **Keep PRs clean:** no dev/test/benchmark/scratch cruft in the repo or diff. Dev scripts go in `scripts/`. Never commit non-documentation markdown (plans/specs/review notes live in the gitignored `docs/superpowers/`).
- `cube/` (experimental semantic-layer/BI stack) is local-only and gitignored — don't reference it from tracked code.
- Commit messages end with: `Co-Authored-By: Claude <noreply@anthropic.com>`
- PR bodies end with: `🤖 Generated with [Claude Code](https://claude.com/claude-code)`

---

## Architecture map (orient fast)

- **Frontend:** `app/page.tsx` is the main workspace (known god-component — shrink it opportunistically, never grow it: new UI goes in `components/`). Shared client logic in `lib/` (`api.ts` client, `table-naming.ts`, `import-read-options.ts` — all unit-tested with vitest).
- **Proxy routes:** `app/api/**/route.ts` forward to the backend at `BACKEND_URL` (default `http://127.0.0.1:8000`).
- **Backend:** `backend/app/main.py` (FastAPI routes) → `datagrunt_service.py` (file parsing via datagrunt), `query_engine.py` (DuckDB session engine; shared connection guarded by a reentrant lock), `session_registry.py` (dataset/table registry, naming), `gcs_service.py` (GCS import/export via ADC), `pdf_service.py` (AI PDF extraction: Gemini/Vertex or local Ollama).
- **Import flow:** upload/GCS → staged file + preview (`preview_with_options`) → user options (skip rows, header, sheet) → `/datasets/confirm` ingests to DuckDB.
- **Containers:** `make up` runs prod-like images via Apple Container (macOS) or Docker Compose; `scripts/stage_adc.sh` stages gcloud ADC into gitignored `.container-secrets/`.
