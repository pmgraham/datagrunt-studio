"""Tracks the datasets in the current session and their backing DuckDB tables."""

import dataclasses
import re
import uuid
from dataclasses import dataclass
from pathlib import Path

from app.query_engine import ColumnInfo, QueryEngine


@dataclass(frozen=True)
class Dataset:
    id: str
    name: str
    source_type: str
    table: str
    columns: list[ColumnInfo]
    sheet: str | None = None
    schema_name: str = "imported"


def _sanitize(text: str) -> str:
    """Replace non-alphanumeric characters with underscores, collapse runs."""
    return re.sub(r"_+", "_", re.sub(r"[^a-zA-Z0-9]", "_", text)).strip("_")


def to_snake_case(filename: str) -> str:
    """Lowercase and snake_case a filename stem."""
    stem = Path(filename).stem.lower()
    sanitized = re.sub(r"[^a-z0-9]+", "_", stem)
    return sanitized.strip("_") or "document"


def base_table_name(name: str, sheet: str | None, schema: str = "imported") -> str:
    """The DuckDB table name for a dataset before any collision suffix.

    The single source of truth for import naming; the frontend mirrors this in
    lib/table-naming.ts (kept in sync by matching contract tests on both sides).
    """
    if schema in ("documents", "rationalized"):
        return to_snake_case(name)
    stem = _sanitize(Path(name).stem) or "dataset"
    sheet_part = f"_{_sanitize(sheet)}" if sheet else ""
    return f"{stem}{sheet_part}"


class SessionRegistry:
    def __init__(self, engine: QueryEngine):
        self._engine = engine
        self._datasets: dict[str, Dataset] = {}

    def _unique_table(self, name: str, sheet: str | None, schema: str = "imported") -> str:
        """Return a stable, collision-deduped DuckDB table name derived from filename."""
        base = base_table_name(name, sheet, schema)

        existing = set(self._engine.list_tables())
        if f"{schema}.{base}" not in existing:
            return base
        counter = 2
        while f"{schema}.{base}_{counter}" in existing:
            counter += 1
        return f"{base}_{counter}"

    def add_from_parquet(
        self,
        name: str,
        source_type: str,
        parquet_path: Path,
        sheet: str | None = None,
        schema_name: str = "imported",
        force_text: bool = True,
    ) -> Dataset:
        schema_name = _sanitize(schema_name) or "imported"
        table = self._unique_table(name, sheet, schema=schema_name)
        qualified_table = f"{self._engine.catalog}.{schema_name}.{table}"
        self._engine.ingest_parquet(qualified_table, parquet_path, force_text=force_text)
        self.update_search_path()

        base = base_table_name(name, sheet, schema_name)
        display_name = name
        if table != base:
            suffix = table[len(base) :]
            p = Path(name)
            if p.suffix:
                display_name = f"{p.stem}{suffix}{p.suffix}"
            else:
                display_name = f"{name}{suffix}"

        return self._register(display_name, source_type, qualified_table, sheet, schema_name=schema_name)

    def add_from_json(self, name: str, source_type: str, json_path: Path, schema_name: str = "documents") -> Dataset:
        schema_name = _sanitize(schema_name) or "documents"
        table = self._unique_table(name, None, schema=schema_name)
        qualified_table = f"{self._engine.catalog}.{schema_name}.{table}"
        self._engine.ingest_json(qualified_table, json_path)
        self.update_search_path()

        base = base_table_name(name, None, schema_name)
        display_name = name
        if table != base:
            suffix = table[len(base) :]
            p = Path(name)
            if p.suffix:
                display_name = f"{p.stem}{suffix}{p.suffix}"
            else:
                display_name = f"{name}{suffix}"

        return self._register(display_name, source_type, qualified_table, None, schema_name=schema_name)

    def add_materialized(self, name: str, source_type: str, table: str, schema_name: str = "imported") -> Dataset:
        schema_name = _sanitize(schema_name) or "imported"
        self._engine.create_schema(schema_name)
        if table.count(".") == 2:
            qualified_table = table
        elif "." in table:
            qualified_table = f"{self._engine.catalog}.{table}"
        else:
            qualified_table = f"{self._engine.catalog}.{schema_name}.{table}"
        self.update_search_path()
        return self._register(name, source_type, qualified_table, None, schema_name=schema_name)

    def _register(
        self, name: str, source_type: str, table: str, sheet: str | None, schema_name: str = "imported"
    ) -> Dataset:
        dataset = Dataset(
            id=uuid.uuid4().hex,
            name=name if sheet is None else f"{name} [{sheet}]",
            source_type=source_type,
            table=table,
            columns=self._engine.table_schema(table),
            sheet=sheet,
            schema_name=schema_name,
        )
        self._datasets[dataset.id] = dataset
        return dataset

    def update_search_path(self) -> None:
        self._engine.create_schema("imported")
        schemas = {"main", "imported"}
        for ds in self._datasets.values():
            schemas.add(ds.schema_name)
        path_str = ",".join(sorted(list(schemas)))
        self._engine.set_search_path(path_str)

    def move_dataset_schema(self, dataset_id: str, new_schema: str) -> Dataset:
        ds = self._datasets[dataset_id]
        old_table = ds.table
        table_name = old_table.split(".")[-1]

        new_schema = _sanitize(new_schema) or "imported"
        new_table = f"{self._engine.catalog}.{new_schema}.{table_name}"

        self._engine.create_schema(new_schema)
        self._engine.move_table(old_table, new_table)

        updated = dataclasses.replace(ds, table=new_table, schema_name=new_schema)
        self._datasets[dataset_id] = updated

        self.update_search_path()
        return updated

    def list(self) -> list[Dataset]:
        return list(self._datasets.values())

    def get(self, dataset_id: str) -> Dataset:
        return self._datasets[dataset_id]

    def refresh_columns(self, dataset_id: str) -> Dataset:
        dataset = self._datasets[dataset_id]
        updated = dataclasses.replace(dataset, columns=self._engine.table_schema(dataset.table))
        self._datasets[dataset_id] = updated
        return updated

    def remove(self, dataset_id: str) -> None:
        dataset = self._datasets[dataset_id]  # raises KeyError if unknown
        self._engine.drop_table(dataset.table)
        del self._datasets[dataset_id]

    def remove_by_name(self, schema_name: str, table_name: str) -> None:
        schema_name = _sanitize(schema_name) or "imported"
        to_remove = None
        for ds in self._datasets.values():
            if ds.schema_name == schema_name and ds.table.split(".")[-1] == table_name:
                to_remove = ds.id
                break
        if to_remove:
            self.remove(to_remove)
        else:
            qualified = f"{self._engine.catalog}.{schema_name}.{table_name}"
            try:
                self._engine.drop_table(qualified)
            except Exception:
                pass

    def reset(self) -> None:
        self._engine.drop_all()
        self._datasets.clear()
