# Datagrunt Dependency Upgrade Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Upgrade the `datagrunt` dependency from version `4.5.4` to `4.5.10` in `datagrunt-studio-backend` and verify no breaking changes occur across backend and frontend test suites.

**Architecture:** Update `pyproject.toml` dependency constraint and regenerate `uv.lock` via `uv lock --upgrade-package datagrunt`, followed by complete regression test execution (`pytest`, `ruff`, `vitest`, `next build`).

**Tech Stack:** Python 3.12, FastAPI, uv, Pytest, Next.js, React, Vitest.

## Global Constraints
- `datagrunt[pdf]>=4.5.10` requirement in `backend/pyproject.toml`.
- Lockfile `backend/uv.lock` must be updated and committed.
- 100% test pass rate across backend (`uv run pytest`) and frontend (`npm test`).

---

### Task 1: Upgrade Datagrunt Dependency & Lockfile

**Files:**
- Modify: `backend/pyproject.toml:18`
- Modify: `backend/uv.lock`

**Interfaces:**
- Consumes: PyPI `datagrunt` package releases.
- Produces: Updated `pyproject.toml` and locked `uv.lock` at `v4.5.10`.

- [ ] **Step 1: Update minimum version in pyproject.toml**

Update line 18 in `backend/pyproject.toml`:
```toml
    "datagrunt[pdf]>=4.5.10",
```

- [ ] **Step 2: Upgrade lockfile via uv**

Run: `uv lock --upgrade-package datagrunt` in `backend/`
Expected output: `Resolved 80 packages ... Update datagrunt v4.5.4 -> v4.5.10`

- [ ] **Step 3: Sync virtual environment**

Run: `uv sync` in `backend/`
Expected output: `Installed 1 package` (or updated datagrunt to 4.5.10)

- [ ] **Step 4: Verify installed version**

Run: `uv tree --depth 1` in `backend/`
Expected output: `datagrunt[pdf] v4.5.10`

- [ ] **Step 5: Commit dependency upgrade**

```bash
git add backend/pyproject.toml backend/uv.lock
git commit -m "chore(deps): upgrade datagrunt to v4.5.10"
```

---

### Task 2: Full Regression Verification & Build Validation

**Files:**
- Test: `backend/tests/`
- Test: `lib/`, `hooks/`

**Interfaces:**
- Consumes: Upgraded `datagrunt v4.5.10` library.
- Produces: Verified passing test suite and production build artifact.

- [ ] **Step 1: Run backend test suite**

Run: `uv run pytest` in `backend/`
Expected output: `258 passed`

- [ ] **Step 2: Run backend linter**

Run: `uv run ruff check .` in `backend/`
Expected output: `All checks passed!`

- [ ] **Step 3: Run frontend test suite**

Run: `npm test` in project root
Expected output: `18 passed (18), 135 passed (135)`

- [ ] **Step 4: Run production frontend build**

Run: `npm run build` in project root
Expected output: `✓ Compiled successfully`

- [ ] **Step 5: Commit verification check & plan completion**

```bash
git add docs/superpowers/plans/2026-07-31-datagrunt-update-plan.md
git commit -m "docs: add datagrunt upgrade implementation plan"
```
