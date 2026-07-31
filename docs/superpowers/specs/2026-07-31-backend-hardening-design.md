# Design Specification: Backend Hardening & Error Sanitization Tests (Issues #43 & #42)

## Overview
This design covers two backend code quality improvements:
1. **Issue #43**: Hardening `QueryEngine` temp view export naming, fixing catalog brittleness in `list_tables()`, and cleaning up legacy export methods.
2. **Issue #42**: Adding revert-detecting security regression tests for exception text sanitization across the remaining 9 API endpoint handlers.

## Proposed Changes

### Component 1: QueryEngine Hardening (Issue #43)
- **[query_engine.py](file:///Users/pmgraham/projects/datagrunt-studio/backend/app/query_engine.py)**
  - Update `_EXPORT_VIEW`: change from `"_export_source"` to `"_studio_export_source_temp_v1"` so a base table named `_export_source` does not trigger infinite view recursion.
  - Update `list_tables()`: add `AND table_type = 'BASE TABLE'` to `information_schema.tables` query so session resets (`drop_all()`) never execute `DROP TABLE` against views.
  - Remove or update legacy `QueryEngine.export()` method to align with sanitized `export_parquet` pattern.
- **[test_query_engine.py](file:///Users/pmgraham/projects/datagrunt-studio/backend/tests/test_query_engine.py)**
  - Add test verifying export works when a user table named `_export_source` exists.
  - Add test verifying `list_tables()` and `drop_all()` operate cleanly when views exist in DuckDB.

### Component 2: Revert-Detecting Error Sanitization Tests (Issue #42)
- **[test_api.py](file:///Users/pmgraham/projects/datagrunt-studio/backend/tests/test_api.py)**
  - Add tests for `confirm_import` and `preview_staged` raising exceptions with sentinel paths (e.g. `/secret/server/path/file.csv`). Verify response JSON lacks sentinel path and logger receives the event.
- **[test_gcs_api.py](file:///Users/pmgraham/projects/datagrunt-studio/backend/tests/test_gcs_api.py)**
  - Add tests for GCS import download, GCS import ingest, and GCS export error paths containing sentinel paths.
- **[test_pdf_api.py](file:///Users/pmgraham/projects/datagrunt-studio/backend/tests/test_pdf_api.py)**
  - Add tests for `pdf_upload`, `pdf_extract`, `pdf_rationalize`, and `get_ollama_models` error paths containing sentinel paths.

## Verification Plan

### Automated Tests
1. `uv run pytest` in `backend/` — all 258+ tests pass cleanly.
2. `uv run ruff check .` in `backend/` — clean lint.
3. Revert-detection validation: temporarily revert one error-sanitization site to verify the new test catches the regression.
