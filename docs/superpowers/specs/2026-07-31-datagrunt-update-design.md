# Design Specification: Datagrunt Dependency Upgrade (v4.5.4 -> v4.5.10)

## Overview
Datagrunt Studio relies on the `datagrunt` Python library for lossless loading and parsing of CSV, Excel, and PDF data files before passing data frames into the DuckDB session engine. This document specifies upgrading `datagrunt` from version `4.5.4` to `4.5.10`.

## Goals
- Update the pinned `datagrunt[pdf]` dependency in `datagrunt-studio` backend from `4.5.4` to `4.5.10`.
- Update `backend/pyproject.toml` dependency constraint to `"datagrunt[pdf]>=4.5.10"`.
- Verify full test suite compatibility and ensure zero regressions across parsing, session management, and API routes.

## Proposed Changes

### Backend Component
1. **[pyproject.toml](file:///Users/pmgraham/projects/datagrunt-studio/backend/pyproject.toml)**
   - Modify line 18: `"datagrunt[pdf]>=4.5.4"` -> `"datagrunt[pdf]>=4.5.10"`.

2. **[uv.lock](file:///Users/pmgraham/projects/datagrunt-studio/backend/uv.lock)**
   - Run `uv lock --upgrade-package datagrunt` to update locked version of `datagrunt` (and `datagrunt[pdf]`) from `4.5.4` to `4.5.10`.

## Verification Plan

### Automated Verification
1. `uv sync` inside `backend/` to sync virtual environment with `uv.lock`.
2. `uv run pytest` to execute all 258 backend unit/integration tests.
3. `uv run ruff check .` to check for any lint issues.
4. `npm test` to run all 135 frontend Vitest tests.
5. `npm run build` to verify production frontend compilation.
