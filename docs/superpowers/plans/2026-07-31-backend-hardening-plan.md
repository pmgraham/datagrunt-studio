# Backend Hardening & Error Sanitization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Harden `QueryEngine` temporary export view naming and catalog table listing (#43), remove legacy export method, and add revert-detecting security regression tests for exception text sanitization across 9 API endpoints (#42).

**Architecture:** Update `backend/app/query_engine.py` view naming and `information_schema.tables` filtering; remove unused `QueryEngine.export`; add parametrized sentinel-path regression tests in `backend/tests/test_api.py`, `test_gcs_api.py`, and `test_pdf_api.py`.

**Tech Stack:** Python 3.12, FastAPI, DuckDB, Pytest.

## Global Constraints
- `_EXPORT_VIEW` constant set to `"_studio_export_source_temp_v1"`.
- `list_tables()` queries `information_schema.tables` with `AND table_type = 'BASE TABLE'`.
- 100% test pass rate across `backend/` (`uv run pytest`) and `npm test`.

---

### Task 1: QueryEngine View Hardening & Catalog Fixes (Issue #43)

**Files:**
- Modify: `backend/app/query_engine.py`
- Modify: `backend/tests/test_query_engine.py`

**Interfaces:**
- Consumes: DuckDB connection.
- Produces: `QueryEngine.list_tables()`, `QueryEngine.export_parquet()`, `QueryEngine.drop_all()`.

- [ ] **Step 1: Write failing tests for temp view recursion and catalog view handling**

In `backend/tests/test_query_engine.py`:
Add `test_export_parquet_with_colliding_user_table` and `test_list_tables_and_drop_all_with_views`:
```python
def test_export_parquet_with_colliding_user_table(engine, tmp_path):
    engine.run_sql("CREATE TABLE _export_source AS SELECT 1 AS id")
    out = tmp_path / "out.parquet"
    engine.export_parquet("SELECT * FROM _export_source", out)
    assert out.exists()

def test_list_tables_ignores_views(engine):
    engine.run_sql("CREATE TABLE t1 AS SELECT 1 AS a")
    engine.run_sql("CREATE VIEW v1 AS SELECT * FROM t1")
    assert engine.list_tables() == ["t1"]
    engine.drop_all()
    assert engine.list_tables() == []
```

- [ ] **Step 2: Run test to verify failure**

Run: `uv run pytest backend/tests/test_query_engine.py -k "test_export_parquet_with_colliding_user_table or test_list_tables_ignores_views" -v`
Expected: FAIL (infinite recursion or catalog error on drop_all).

- [ ] **Step 3: Update query_engine.py**

In `backend/app/query_engine.py`:
1. Change `_EXPORT_VIEW = "_export_source"` to `_EXPORT_VIEW = "_studio_export_source_temp_v1"`.
2. In `list_tables()`, add `AND table_type = 'BASE TABLE'` to the query.
3. Remove unused legacy `export` method (lines 355-368).

- [ ] **Step 4: Run test to verify passing**

Run: `uv run pytest backend/tests/test_query_engine.py -v`
Expected: PASS (all tests in `test_query_engine.py` pass).

- [ ] **Step 5: Commit changes**

```bash
git add backend/app/query_engine.py backend/tests/test_query_engine.py
git commit -m "fix(backend): harden export temp view and catalog view listing (#43)"
```

---

### Task 2: Revert-Detecting Error Sanitization Tests (Issue #42)

**Files:**
- Modify: `backend/tests/test_api.py`
- Modify: `backend/tests/test_gcs_api.py`
- Modify: `backend/tests/test_pdf_api.py`

**Interfaces:**
- Consumes: FastAPI endpoints (`confirm_import`, `preview_staged`, GCS routes, PDF routes).
- Produces: Regression tests asserting exception text / file paths are omitted from API responses.

- [ ] **Step 1: Add error sanitization tests in test_api.py**

In `backend/tests/test_api.py`:
Add tests mocking `confirm_import` and `preview_staged` failures with sentinel path `/secret/server/path/file.csv`.
Assert sentinel path is NOT in `response.json()` and logged to `app.error_reporting`.

- [ ] **Step 2: Add error sanitization tests in test_gcs_api.py**

In `backend/tests/test_gcs_api.py`:
Add tests for GCS download, GCS ingest, and GCS export raising exceptions with sentinel path.
Assert response does NOT contain sentinel path and logged to `app.error_reporting`.

- [ ] **Step 3: Add error sanitization tests in test_pdf_api.py**

In `backend/tests/test_pdf_api.py`:
Add tests for `pdf_upload`, `pdf_extract`, `pdf_rationalize`, and `get_ollama_models` raising exceptions with sentinel path.
Assert response does NOT contain sentinel path and logged to `app.error_reporting`.

- [ ] **Step 4: Run full backend test suite**

Run: `uv run pytest` in `backend/`
Expected: All 258+ tests pass.

- [ ] **Step 5: Commit changes**

```bash
git add backend/tests/test_api.py backend/tests/test_gcs_api.py backend/tests/test_pdf_api.py
git commit -m "test(backend): add revert-detecting error sanitization tests (#42)"
```
