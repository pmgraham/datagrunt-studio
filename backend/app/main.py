import asyncio
import json
import mimetypes
import os
import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import duckdb
from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel

import app.pdf_service as pdf_svc
from app import datagrunt_service as svc
from app import gcs_service as gcs
from app import sql_builder as sb
from app.api_models import (
    CastRequest,
    CastResponse,
    ColumnDTO,
    ConfirmImportRequest,
    DatasetDTO,
    ExportRequest,
    GcsExportRequest,
    GcsImportRequest,
    GcsImportResponse,
    PageRequest,
    PageResponse,
    PreviewResponse,
    QueryRequest,
    QueryResponse,
    SchemaRequest,
    StagedPreviewRequest,
    StagedSheetPreview,
    StatementResultDTO,
)
from app.query_engine import QueryEngine
from app.session import SESSION, SETTINGS
from app.session_registry import Dataset, base_table_name, to_snake_case

app = FastAPI(title="Datagrunt Studio Backend")

_EXCEL_SUFFIXES = {".xlsx", ".xls"}
# Untyped formats go through the staged preview/confirm flow; parquet and
# JSON are already typed and register directly.
_STAGED_SUFFIXES = {".csv"} | _EXCEL_SUFFIXES


def _staged_path(staged_id: str) -> Path | None:
    """Resolve a staged upload by id, rejecting anything that escapes the upload dir.

    Staged ids are minted server-side in ``preview_datasets`` as
    ``{uuid4hex}_{basename}`` and always name a direct child of the upload dir.
    A client-supplied traversal attempt (``../`` or an absolute path) resolves
    elsewhere and is rejected, so it can't be read into a table or unlinked.
    """
    base = SESSION.upload_dir.resolve()
    candidate = (base / staged_id).resolve()
    if candidate.parent != base:
        return None
    return candidate


_UI_TYPE_TO_DUCK = {
    "text": "VARCHAR",
    "integer": "BIGINT",
    "decimal": "DOUBLE",
    "boolean": "BOOLEAN",
    "date": "DATE",
    "timestamp": "TIMESTAMP",
}


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


def _to_dto(ds: Dataset) -> DatasetDTO:
    return DatasetDTO(
        id=ds.id,
        name=ds.name,
        type=ds.source_type,
        table=ds.table,
        sheet=ds.sheet,
        columns=[ColumnDTO(name=c.name, type=c.type) for c in ds.columns],
        schema_name=ds.schema_name,
    )


def _all_dtos() -> dict:
    return {"datasets": [_to_dto(d) for d in SESSION.registry.list()]}


@app.get("/datasets")
def list_datasets() -> dict:
    return _all_dtos()


def _parse_file(original_name: str, dest: Path) -> list[tuple[str, Path, str | None]]:
    """Parse one staged upload into (source_type, parquet_path, sheet) tuples.

    Pure with respect to session state — it only reads the file and writes
    parquet — so it is safe to run in a worker thread alongside other parses.
    """
    if dest.suffix.lower() in _EXCEL_SUFFIXES:
        return [("excel", r.parquet_path, r.sheet) for r in svc.parse_excel(dest, SESSION.parquet_dir)]
    result = svc.parse_csv(dest, SESSION.parquet_dir)
    return [("csv", result.parquet_path, None)]


def _staged_preview_entry(staged_id: str, filename: str, dest: Path) -> dict:
    """Build one staged-file preview entry, tolerating parse failures.

    A file whose default-options preview fails (e.g. a ragged CSV preamble)
    is still staged: the error is surfaced so the user can fix it with the
    skip-rows controls, where the re-preview endpoint recovers.
    """
    try:
        preview = svc.preview_file(dest)
        return {
            "staged_id": staged_id,
            "filename": filename,
            "sheets": preview["sheets"],
            "columns": preview["columns"],
            "columns_normalized": preview["columns_normalized"],
            "rows": preview["rows"],
            "error": None,
        }
    except Exception as exc:
        sheets = None
        if dest.suffix.lower() in _EXCEL_SUFFIXES:
            try:
                sheets = svc.list_excel_sheets(dest)
            except Exception:
                sheets = None
        return {
            "staged_id": staged_id,
            "filename": filename,
            "sheets": sheets,
            "columns": None,
            "columns_normalized": None,
            "rows": None,
            "error": f"Could not parse with default settings: {exc}",
        }


@app.post("/datasets/preview", response_model=PreviewResponse)
async def preview_datasets(files: list[UploadFile] = File(...)) -> dict:
    SESSION.upload_dir.mkdir(parents=True, exist_ok=True)
    staged_files = []
    for f in files:
        safe_name = Path(f.filename or f"upload_{uuid.uuid4().hex}").name
        staged_id = f"{uuid.uuid4().hex}_{safe_name}"
        dest = SESSION.upload_dir / staged_id
        dest.write_bytes(await f.read())
        staged_files.append(_staged_preview_entry(staged_id, safe_name, dest))

    return {"is_single": len(files) == 1, "files": staged_files}


@app.post("/datasets/confirm")
def confirm_import(req: ConfirmImportRequest) -> dict:
    created: list[Dataset] = []
    errors: list[dict] = []

    for item in req.files:
        dest = _staged_path(item.staged_id)
        if dest is None or not dest.exists():
            errors.append({"filename": item.filename, "message": "Staged file not found"})
            continue

        try:
            is_excel = dest.suffix.lower() in _EXCEL_SUFFIXES
            if is_excel:
                sheet_opts = {
                    name: svc.ReadOptions(skip_rows=o.skip_rows, has_header=o.has_header)
                    for name, o in (item.sheet_options or {}).items()
                }
                results = svc.parse_excel(
                    dest,
                    SESSION.parquet_dir,
                    sheet=item.sheet,
                    normalize_columns=item.normalize_columns,
                    sheet_options=sheet_opts,
                )
            else:
                results = [
                    svc.parse_csv(
                        dest,
                        SESSION.parquet_dir,
                        normalize_columns=item.normalize_columns,
                        options=svc.ReadOptions(skip_rows=item.skip_rows, has_header=item.has_header),
                    )
                ]

            for r in results:
                if item.overwrite:
                    base = base_table_name(item.filename, r.sheet, item.schema_name)
                    SESSION.registry.remove_by_name(item.schema_name, base)

                created.append(
                    SESSION.registry.add_from_parquet(
                        item.filename,
                        "excel" if is_excel else "csv",
                        r.parquet_path,
                        r.sheet,
                        schema_name=item.schema_name,
                    )
                )
        except Exception as exc:
            errors.append({"filename": item.filename, "message": str(exc)})
        finally:
            if dest.exists():
                dest.unlink()

    return {"datasets": [_to_dto(d) for d in created], "errors": errors}


@app.post("/datasets/staged/{staged_id}/preview", response_model=StagedSheetPreview)
def preview_staged(staged_id: str, req: StagedPreviewRequest) -> dict:
    """Re-parse one sheet (or the CSV) of an already-staged file under
    user-supplied read options. The upload-time preview is unchanged."""
    dest = _staged_path(staged_id)
    if dest is None or not dest.exists():
        raise HTTPException(status_code=404, detail="Staged file not found")
    try:
        return svc.preview_with_options(
            dest,
            options=svc.ReadOptions(skip_rows=req.skip_rows, has_header=req.has_header),
            sheet=req.sheet,
        )
    except Exception as exc:
        raise HTTPException(
            status_code=400,
            detail=f"Could not parse with skip_rows={req.skip_rows}: {exc}",
        )


@app.post("/datasets")
async def upload_dataset(files: list[UploadFile] = File(...)) -> dict:
    SESSION.upload_dir.mkdir(parents=True, exist_ok=True)

    # Stage 1: persist each upload to disk, preserving selection order. The uuid
    # prefix keeps each path — and its derived parquet output path — unique, even
    # when two selected files share a name.
    staged: list[tuple[str, Path]] = []
    for f in files:
        safe_name = Path(f.filename or f"upload_{uuid.uuid4().hex}").name
        dest = SESSION.upload_dir / f"{uuid.uuid4().hex}_{safe_name}"
        dest.write_bytes(await f.read())
        staged.append((safe_name, dest))

    # Stage 2: parse in parallel. Each parse builds its own datagrunt writer and
    # writes a unique parquet path, so the worker threads never share state.
    loop = asyncio.get_running_loop()
    with ThreadPoolExecutor(max_workers=max(1, min(len(staged), os.cpu_count() or 4))) as pool:
        parsed = await asyncio.gather(
            *(loop.run_in_executor(pool, _parse_file, name, dest) for name, dest in staged),
            return_exceptions=True,
        )

    # Stage 3: register sequentially in input order; a parse that raised becomes
    # an error entry instead of failing the whole request.
    created: list[Dataset] = []
    errors: list[dict] = []
    for (name, _dest), result in zip(staged, parsed):
        if isinstance(result, Exception):
            errors.append({"filename": name, "message": str(result)})
            continue
        for source_type, parquet_path, sheet in result:
            created.append(SESSION.registry.add_from_parquet(name, source_type, parquet_path, sheet))

    return {"datasets": [_to_dto(d) for d in created], "errors": errors}


@app.post("/session/reset")
def reset_session() -> dict:
    SESSION.seed()
    return _all_dtos()


@app.delete("/datasets/{dataset_id}")
def delete_dataset(dataset_id: str) -> dict:
    try:
        SESSION.registry.remove(dataset_id)
    except KeyError:
        raise HTTPException(status_code=404, detail=f"Dataset {dataset_id!r} not found")
    return _all_dtos()


_PREVIEW_ROW_CAP = 1000


@app.get("/datasets/{dataset_id}/preview")
def preview_dataset(dataset_id: str, limit: int = _PREVIEW_ROW_CAP) -> dict:
    try:
        ds = SESSION.registry.get(dataset_id)
    except KeyError:
        raise HTTPException(status_code=404, detail=f"Unknown dataset: {dataset_id}")
    limit = max(1, min(limit, _PREVIEW_ROW_CAP))
    result = SESSION.engine.table_sample(ds.table, limit=limit)
    return {"columns": result.columns, "rows": result.rows, "truncated": result.truncated}


@app.get("/datasets/{dataset_id}/sheets")
def get_dataset_sheets(dataset_id: str) -> dict:
    try:
        ds = SESSION.registry.get(dataset_id)
    except KeyError:
        raise HTTPException(status_code=404, detail=f"Dataset {dataset_id!r} not found")
    if ds.sheet is None:
        return {"sheets": []}
    # Derive the workbook filename from the display name: "q4_forecast.xlsx [forecast]" → "q4_forecast.xlsx"
    workbook_name = ds.name.split(" [")[0]
    seen: set[str] = set()
    sheets: list[str] = []
    for candidate in SESSION.registry.list():
        if candidate.name.split(" [")[0] == workbook_name and candidate.sheet is not None:
            if candidate.sheet not in seen:
                seen.add(candidate.sheet)
                sheets.append(candidate.sheet)
    return {"sheets": sheets}


@app.post("/datasets/{dataset_id}/cast", response_model=CastResponse)
def cast_dataset_column(dataset_id: str, req: CastRequest) -> CastResponse:
    try:
        ds = SESSION.registry.get(dataset_id)
    except KeyError:
        raise HTTPException(status_code=404, detail=f"Dataset {dataset_id!r} not found")
    duck_type = _UI_TYPE_TO_DUCK.get(req.type)
    if duck_type is None:
        raise HTTPException(status_code=400, detail=f"Unsupported type: {req.type!r}")
    try:
        result = SESSION.engine.cast_column(ds.table, req.column, duck_type, req.lenient)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    if result.ok:
        SESSION.registry.refresh_columns(dataset_id)
    return CastResponse(
        ok=result.ok,
        failingCount=result.failing_count,
        example=result.example,
        nulledCount=result.nulled_count,
        columns=[ColumnDTO(name=c.name, type=c.type) for c in result.columns],
    )


def validate_replacement_value(value: str, col_type: str) -> None:
    """Validate that the replacement value is castable/compatible with the column type."""
    ctype = col_type.upper()
    if ctype in ("INTEGER", "BIGINT", "SMALLINT", "TINYINT", "HUGEINT"):
        try:
            int(value)
        except (TypeError, ValueError):
            raise ValueError(f"Value '{value}' is not a valid integer for column of type {col_type}")
    elif ctype in ("DOUBLE", "FLOAT", "REAL", "DECIMAL", "NUMERIC"):
        try:
            float(value)
        except (TypeError, ValueError):
            raise ValueError(f"Value '{value}' is not a valid number for column of type {col_type}")
    elif ctype == "BOOLEAN":
        if value.strip().lower() not in ("true", "false", "1", "0", "yes", "no"):
            raise ValueError(f"Value '{value}' is not a valid boolean (true/false) for column of type {col_type}")
    elif ctype == "DATE":
        import re

        if not re.match(r"^\d{4}-\d{2}-\d{2}$", value.strip()):
            raise ValueError(f"Value '{value}' must be in YYYY-MM-DD format for column of type {col_type}")
    elif ctype in ("TIMESTAMP", "TIMESTAMPTZ"):
        import re

        if not re.match(
            r"^\d{4}-\d{2}-\d{2}(?:\s|T)\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?$", value.strip()
        ):
            raise ValueError(
                f"Value '{value}' must be a valid timestamp (e.g. YYYY-MM-DD HH:MM:SS) for column of type {col_type}"
            )


def get_column_type_at_step(steps: list, current_idx: int, initial_columns: list, target_column: str) -> str | None:
    curr_col = target_column
    for idx in range(current_idx - 1, -1, -1):
        step = steps[idx]
        if step.op == "rename" and step.newName == curr_col:
            curr_col = step.column
        elif step.op == "cast" and step.column == curr_col:
            return step.castType
    col = next((c for c in initial_columns if c.name == curr_col), None)
    return col.type if col else None


def _resolve_sql_and_code(req: QueryRequest) -> tuple[str, str]:
    if req.mode == "sql":
        if req.sql is None:
            raise ValueError("sql is required for mode 'sql'")
        return req.sql, f"# DuckDB SQL (Studio session)\n{req.sql}"
    if req.mode == "clean":
        if req.clean is None and not req.clean_pipeline:
            raise ValueError("clean or clean_pipeline params are required for mode 'clean'")
        if req.clean_pipeline:
            first_step = req.clean_pipeline[0]
            ds = SESSION.registry.get(first_step.datasetId)
            for idx, step in enumerate(req.clean_pipeline):
                if step.op == "fill_null" and step.value is not None:
                    col_type = get_column_type_at_step(req.clean_pipeline, idx, ds.columns, step.column)
                    if col_type:
                        validate_replacement_value(step.value, col_type)
            sql = sb.build_clean_pipeline_sql(ds.table, req.clean_pipeline, ds.columns)
        else:
            c = req.clean
            ds = SESSION.registry.get(c.datasetId)
            col_type = None
            if c.op == "fill_null" and c.value is not None:
                col = next((col for col in ds.columns if col.name == c.column), None)
                if col:
                    col_type = col.type
                    validate_replacement_value(c.value, col_type)
            sql = sb.build_clean_sql(ds.table, c.op, c.column, c.value, c.newName, c.castType, column_type=col_type)
        code = sb.snippet_for_load(ds.table, ds.name, ds.source_type) + f"\n\n# Studio transform:\n{sql}"
        return sql, code
    if req.mode == "join":
        if req.join is None:
            raise ValueError("join params are required for mode 'join'")
        j = req.join
        left = SESSION.registry.get(j.leftId)
        right = SESSION.registry.get(j.rightId)
        sql = sb.build_join_sql(left.table, right.table, j.leftKey, j.rightKey, j.how)
        return sql, f"# Studio join (DuckDB)\n{sql}"
    raise ValueError(f"Unknown mode: {req.mode}")


@app.post("/query", response_model=QueryResponse)
def run_query(req: QueryRequest) -> QueryResponse:
    try:
        sql, code = _resolve_sql_and_code(req)
        if req.saveAs and len(QueryEngine.split_statements(sql)) > 1:
            return QueryResponse(
                error="ValueError",
                detail="Save As requires a single SQL statement; remove the extra statements.",
            )
        stmt_results = SESSION.engine.run_statements(sql, limit=SETTINGS.result_row_cap)
        if not stmt_results:
            return QueryResponse(error="ValueError", detail="No SQL statement to execute.", results=[])
        dtos = [
            StatementResultDTO(
                columns=r.columns,
                rows=r.rows,
                truncated=r.truncated,
                statement=r.statement,
                has_result_set=r.has_result_set,
                error=r.error,
                detail=r.detail,
            )
            for r in stmt_results
        ]
        if not any(r.error is None for r in stmt_results):
            failing = stmt_results[0]
            return QueryResponse(error=failing.error, detail=failing.detail, results=dtos)
        if req.saveAs:
            table = "".join(ch if ch.isalnum() else "_" for ch in req.saveAs)
            schema = "cleaned" if req.mode == "clean" else "imported"
            qualified_table = f"{schema}.{table}"
            SESSION.engine.materialize(qualified_table, sql)
            ds_type = "cleaned" if req.mode == "clean" else "csv"
            SESSION.registry.add_materialized(req.saveAs, ds_type, qualified_table, schema_name=schema)
        last_ok = next(
            (r for r in reversed(stmt_results) if r.error is None and r.has_result_set),
            None,
        )
        return QueryResponse(
            columns=last_ok.columns if last_ok else [],
            rows=last_ok.rows if last_ok else [],
            truncated=last_ok.truncated if last_ok else False,
            sql=sql,
            code=code,
            results=dtos,
        )
    except Exception as exc:  # structured error, never a 500 for user-facing query mistakes
        return QueryResponse(error=type(exc).__name__, detail=str(exc))


def _resolve_source(dataset_id: str | None, sql: str | None) -> tuple[str, str]:
    """(source_sql, basename) for endpoints that accept a dataset OR a statement."""
    if bool(dataset_id) == bool(sql):
        raise HTTPException(status_code=400, detail="Provide exactly one of datasetId or sql")
    if dataset_id:
        try:
            ds = SESSION.registry.get(dataset_id)
        except KeyError:
            raise HTTPException(status_code=404, detail=f"Unknown dataset: {dataset_id}")
        # Last segment of the (already sanitized) qualified table name — safe
        # as a filename, no path traversal surface.
        return SESSION.engine.table_select_sql(ds.table), ds.table.split(".")[-1]
    return sql.strip().rstrip(";"), "results"


@app.post("/export")
def export_dataset(req: ExportRequest) -> FileResponse:
    if req.format not in ("csv", "parquet"):
        raise HTTPException(status_code=400, detail=f"Unsupported format: {req.format!r}")
    source_sql, basename = _resolve_source(req.datasetId, req.sql)

    exports_dir = SESSION.parquet_dir.parent / "exports"
    parquet_out = exports_dir / f"{basename}.parquet"
    try:
        SESSION.engine.export_parquet(source_sql, parquet_out)
    except duckdb.Error as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    if req.format == "parquet":
        return FileResponse(
            str(parquet_out),
            filename=f"{basename}.parquet",
            media_type="application/octet-stream",
        )

    csv_out = exports_dir / f"{basename}.csv"
    svc.parquet_to_csv(parquet_out, csv_out)
    return FileResponse(str(csv_out), filename=f"{basename}.csv", media_type="text/csv")


def _gcs_http_error(exc: Exception) -> HTTPException:
    """Map GCS failures to readable HTTP errors (never a bare 500)."""
    if isinstance(exc, gcs.GcsCredentialsError):
        return HTTPException(status_code=400, detail=str(exc))
    status = getattr(exc, "code", None)  # google.api_core exceptions carry .code
    if isinstance(status, int) and 400 <= status < 500:
        return HTTPException(status_code=status, detail=str(exc))
    return HTTPException(status_code=502, detail=f"GCS error: {exc}")


@app.get("/gcs/projects")
def gcs_projects() -> dict:
    try:
        return {"projects": gcs.list_projects()}
    except Exception as exc:
        raise _gcs_http_error(exc) from exc


@app.get("/gcs/buckets")
def gcs_buckets(project: str | None = None) -> dict:
    try:
        return {"buckets": gcs.list_buckets(project)}
    except Exception as exc:
        raise _gcs_http_error(exc) from exc


_OBJECT_KIND_SUFFIXES = {"datasets": gcs.IMPORTABLE_SUFFIXES, "pdf": gcs.PDF_SUFFIXES}


@app.get("/gcs/objects")
def gcs_objects(bucket: str, prefix: str = "", kind: str = "datasets") -> dict:
    suffixes = _OBJECT_KIND_SUFFIXES.get(kind)
    if suffixes is None:
        raise HTTPException(status_code=400, detail=f"Unknown object kind: {kind!r}")
    try:
        listing = gcs.list_objects(bucket, prefix, suffixes=suffixes)
    except Exception as exc:
        raise _gcs_http_error(exc) from exc
    return {
        "folders": listing["folders"],
        "files": [{"name": o.name, "size": o.size, "updated": o.updated} for o in listing["files"]],
    }


@app.post("/gcs/import", response_model=GcsImportResponse)
def gcs_import(req: GcsImportRequest) -> GcsImportResponse:
    """Download selected objects and route each by type: CSV and Excel join
    the staged preview/confirm flow; parquet and JSON register directly
    (already typed)."""
    SESSION.upload_dir.mkdir(parents=True, exist_ok=True)
    previews: list[dict] = []
    created: list = []
    errors: list[dict] = []

    for object_name in req.objects:
        filename = Path(object_name).name
        suffix = Path(filename).suffix.lower()
        if suffix not in gcs.IMPORTABLE_SUFFIXES:
            errors.append({"filename": filename, "message": f"Unsupported file type: {suffix or '(none)'}"})
            continue

        staged_id = f"{uuid.uuid4().hex}_{filename}"
        dest = SESSION.upload_dir / staged_id
        try:
            gcs.download_object(req.bucket, object_name, dest)
        except gcs.GcsCredentialsError as exc:
            raise _gcs_http_error(exc) from exc
        except Exception as exc:
            errors.append({"filename": filename, "message": str(exc)})
            continue

        try:
            if suffix in _STAGED_SUFFIXES:
                previews.append(_staged_preview_entry(staged_id, filename, dest))
            elif suffix == ".parquet":
                ds = SESSION.registry.add_from_parquet(
                    filename,
                    "parquet",
                    dest,
                    schema_name=req.schema_name,
                    force_text=False,
                )
                created.append(_to_dto(ds))
                dest.unlink()
            else:  # .json
                ds = SESSION.registry.add_from_json(
                    filename,
                    "json",
                    dest,
                    schema_name=req.schema_name,
                )
                created.append(_to_dto(ds))
                dest.unlink()
        except Exception as exc:
            if dest.exists():
                dest.unlink()
            errors.append({"filename": filename, "message": str(exc)})

    return GcsImportResponse(previews=previews, datasets=created, errors=errors)


@app.post("/gcs/export")
def gcs_export(req: GcsExportRequest) -> dict:
    """Export a dataset or statement result to GCS. The file is produced by the
    same local export path as /export, then uploaded."""
    if req.format not in ("csv", "parquet", "json"):
        raise HTTPException(status_code=400, detail=f"Unsupported format: {req.format!r}")
    bucket = req.bucket.strip()
    if not bucket:
        raise HTTPException(status_code=400, detail="bucket is required")
    source_sql, basename = _resolve_source(req.datasetId, req.sql)
    object_name = gcs.resolve_object_name(req.path, basename, req.format)

    exports_dir = SESSION.parquet_dir.parent / "exports"
    parquet_out = exports_dir / f"{basename}.parquet"
    try:
        SESSION.engine.export_parquet(source_sql, parquet_out)
    except duckdb.Error as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    if req.format == "csv":
        local_out = exports_dir / f"{basename}.csv"
        svc.parquet_to_csv(parquet_out, local_out)
    elif req.format == "json":
        local_out = exports_dir / f"{basename}.json"
        svc.parquet_to_json(parquet_out, local_out)
    else:
        local_out = parquet_out

    try:
        uri = gcs.upload_file(local_out, bucket, object_name)
    except Exception as exc:
        raise _gcs_http_error(exc) from exc
    return {"uri": uri}


@app.post("/page", response_model=PageResponse)
def page_rows(req: PageRequest) -> PageResponse:
    if req.offset < 0:
        raise HTTPException(status_code=400, detail="offset must be >= 0")
    if not 1 <= req.limit <= 200:
        raise HTTPException(status_code=400, detail="limit must be between 1 and 200")
    if req.sortDirection not in ("asc", "desc"):
        raise HTTPException(status_code=400, detail="sortDirection must be 'asc' or 'desc'")
    source_sql, _ = _resolve_source(req.datasetId, req.sql)
    try:
        result = SESSION.engine.page(
            source_sql,
            req.offset,
            req.limit,
            search=req.search,
            sort_column=req.sortColumn,
            sort_direction=req.sortDirection,
        )
    except duckdb.Error as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return PageResponse(columns=result.columns, rows=result.rows, total=result.total)


@app.post("/datasets/{dataset_id}/schema", response_model=DatasetDTO)
def move_dataset_schema(dataset_id: str, req: SchemaRequest) -> DatasetDTO:
    try:
        SESSION.registry.get(dataset_id)
    except KeyError:
        raise HTTPException(status_code=404, detail=f"Dataset {dataset_id!r} not found")
    try:
        updated = SESSION.registry.move_dataset_schema(dataset_id, req.schema_name)
        return _to_dto(updated)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc))


# --- AI PDF EXTRACTOR & RATIONALIZER ENDPOINTS ---


class RationalizeRequest(BaseModel):
    prompt: str
    use_local: bool
    model: str
    use_page_images: bool = False


class PdfGcsImportRequest(BaseModel):
    bucket: str
    object: str


@app.post("/pdf/upload")
async def pdf_upload(file: UploadFile = File(...)):
    if not gcs.is_importable_object(file.filename, gcs.PDF_SUFFIXES):
        raise HTTPException(status_code=400, detail="Only PDF files are supported.")
    try:
        contents = await file.read()
        doc_id = pdf_svc.save_upload(file.filename, contents)
        return {"doc_id": doc_id, "filename": file.filename}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/pdf/import-gcs")
def pdf_import_gcs(req: PdfGcsImportRequest) -> dict:
    """Download a PDF from GCS server-side and land it exactly like a local
    upload — same {doc_id, filename} contract as /pdf/upload."""
    filename = Path(req.object).name
    if not gcs.is_importable_object(filename, gcs.PDF_SUFFIXES):
        raise HTTPException(status_code=400, detail="Only PDF files are supported.")
    try:
        contents = gcs.download_object_bytes(req.bucket, req.object)
    except Exception as exc:
        raise _gcs_http_error(exc) from exc
    try:
        doc_id = pdf_svc.save_upload(filename, contents)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
    return {"doc_id": doc_id, "filename": filename}


@app.get("/pdf/file/{doc_id}")
def pdf_file(doc_id: str):
    if not pdf_svc.valid_id(doc_id):
        raise HTTPException(status_code=400, detail="Invalid doc_id.")
    p = pdf_svc.pdf_path(doc_id)
    if not p.exists():
        raise HTTPException(status_code=404, detail="PDF not found.")
    return FileResponse(str(p), media_type="application/pdf")


@app.post("/pdf/extract/{doc_id}")
def pdf_extract(doc_id: str, overwrite: bool = False):
    if not pdf_svc.valid_id(doc_id):
        raise HTTPException(status_code=400, detail="Invalid doc_id.")
    if not pdf_svc.pdf_path(doc_id).exists():
        raise HTTPException(status_code=404, detail="PDF not found.")
    try:
        json_text = pdf_svc.extract_pdf(doc_id)
        imgs = pdf_svc.images(doc_id)
        page_imgs = pdf_svc.page_images(doc_id)
        md_text = ""
        mp = pdf_svc.md_path(doc_id)
        if mp.exists():
            md_text = mp.read_text(encoding="utf-8")

        # Save raw extracted json to duckdb table under "documents" schema
        filename = pdf_svc.original_name(doc_id)
        if overwrite:
            base = base_table_name(filename, None, "documents")
            SESSION.registry.remove_by_name("documents", base)

        SESSION.registry.add_from_json(filename, "pdf", pdf_svc.json_path(doc_id), schema_name="documents")

        return {"json_text": json_text, "markdown_text": md_text, "images": imgs, "page_images": page_imgs}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Extraction failed: {str(e)}")


@app.get("/pdf/image/{doc_id}/{filename}")
def pdf_image(doc_id: str, filename: str):
    if not pdf_svc.valid_id(doc_id):
        raise HTTPException(status_code=400, detail="Invalid doc_id.")
    p = pdf_svc.image_file(doc_id, filename)
    if not p or not p.exists():
        raise HTTPException(status_code=404, detail="Image not found.")
    mime, _ = mimetypes.guess_type(str(p))
    return FileResponse(str(p), media_type=mime or "image/png")


@app.get("/pdf/page-image/{doc_id}/{filename}")
def pdf_page_image(doc_id: str, filename: str):
    if not pdf_svc.valid_id(doc_id):
        raise HTTPException(status_code=400, detail="Invalid doc_id.")
    p = pdf_svc.page_image_file(doc_id, filename)
    if not p or not p.exists():
        raise HTTPException(status_code=404, detail="Page image not found.")
    mime, _ = mimetypes.guess_type(str(p))
    return FileResponse(str(p), media_type=mime or "image/png")


def _save_rationalized(doc_id: str, use_page_images: bool, schema_text: str) -> tuple[Dataset | None, str | None]:
    """Persist rationalized LLM output as a dataset under the `rationalized` schema.

    Returns (dataset, save_error) — exactly one is non-None. A failed save must
    not fail the rationalize request, so every error comes back as text.
    Page-image runs get a `_page_images` name suffix so the two modes never
    collide; re-runs of the same document+mode silently replace the table.
    """
    try:
        json.loads(schema_text)
    except json.JSONDecodeError as e:
        return None, f"LLM output is not valid JSON: {e}"

    name = to_snake_case(pdf_svc.original_name(doc_id))
    if use_page_images:
        name = f"{name}_page_images"
    try:
        SESSION.registry.remove_by_name("rationalized", base_table_name(name, None, "rationalized"))
        dataset = SESSION.registry.add_from_json(
            name, "pdf_rationalized", pdf_svc.schema_path(doc_id), schema_name="rationalized"
        )
        return dataset, None
    except Exception as e:
        return None, f"Could not ingest rationalized JSON: {e}"


@app.post("/pdf/rationalize/{doc_id}")
def pdf_rationalize(doc_id: str, req: RationalizeRequest):
    if not pdf_svc.valid_id(doc_id):
        raise HTTPException(status_code=400, detail="Invalid doc_id.")
    if not pdf_svc.pdf_path(doc_id).exists():
        raise HTTPException(status_code=404, detail="PDF not found.")
    try:
        schema = pdf_svc.rationalize(doc_id, req.prompt, req.use_local, req.model, req.use_page_images)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Rationalization failed: {str(e)}")

    dataset, save_error = _save_rationalized(doc_id, req.use_page_images, schema)
    return {
        "schema": schema,
        "saved": dataset is not None,
        "dataset": _to_dto(dataset) if dataset else None,
        "save_error": save_error,
    }


@app.get("/pdf/ollama-models")
def get_ollama_models():
    try:
        return pdf_svc.get_ollama_models()
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/pdf/gemini-models")
def get_gemini_models():
    try:
        return pdf_svc.get_gemini_models()
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
