"""Thin wrapper over Datagrunt. Datagrunt's only job here: load/parse files
and convert them to Parquet (and other formats). No transform logic lives here."""

from dataclasses import dataclass
from pathlib import Path

from datagrunt import CSVReader, CSVWriter, ExcelReader, ExcelWriter, ParquetWriter


@dataclass(frozen=True)
class ParseResult:
    sheet: str | None
    parquet_path: Path


_EXCEL_SUFFIXES = {".xlsx", ".xls"}


@dataclass(frozen=True)
class ReadOptions:
    """User-facing import options; a uniform contract translated per engine."""

    skip_rows: int = 0
    has_header: bool = True

    @property
    def is_default(self) -> bool:
        return self.skip_rows == 0 and self.has_header


DEFAULT_READ_OPTIONS = ReadOptions()


def _excel_read_kwargs(options: ReadOptions) -> dict:
    """Translate to pl.read_excel kwargs. calamine's skip_rows skips rows
    AFTER the header row, so header-on-row-N must use header_row instead."""
    if options.is_default:
        return {}
    if not options.has_header:
        kwargs: dict = {"has_header": False}
        if options.skip_rows:
            kwargs["read_options"] = {"skip_rows": options.skip_rows}
        return kwargs
    return {"read_options": {"header_row": options.skip_rows}}


def _csv_read_kwargs(options: ReadOptions) -> dict:
    if options.is_default:
        return {}
    return {"skip_rows": options.skip_rows, "has_header": options.has_header}


def _preview_dict(df_orig, df_norm, max_rows: int) -> dict:
    rows = [[str(x) if x is not None else "" for x in r] for r in df_orig.head(max_rows).rows()]
    return {
        "columns": df_orig.columns,
        "columns_normalized": df_norm.columns,
        "rows": rows,
    }


def preview_with_options(
    upload_path: Path,
    options: ReadOptions = DEFAULT_READ_OPTIONS,
    sheet: str | None = None,
    max_rows: int = 5,
) -> dict:
    """Preview one sheet (or the CSV) under the given read options.

    Fresh reader instances per call — reusing one across reads with
    different options raises ComputeError in datagrunt 4.5.4.
    """
    if upload_path.suffix.lower() in _EXCEL_SUFFIXES:
        kwargs = _excel_read_kwargs(options)
        df_orig = ExcelReader(str(upload_path), normalize_columns=False).get_sample(sheet=sheet, **kwargs)
        df_norm = ExcelReader(str(upload_path), normalize_columns=True).get_sample(sheet=sheet, **kwargs)
    else:
        kwargs = _csv_read_kwargs(options)
        df_orig = CSVReader(str(upload_path), engine="polars", normalize_columns=False).to_dataframe(
            n_rows=max_rows, **kwargs
        )
        df_norm = CSVReader(str(upload_path), engine="polars", normalize_columns=True).to_dataframe(
            n_rows=max_rows, **kwargs
        )
    return _preview_dict(df_orig, df_norm, max_rows)


def _parquet_name(stem: str, sheet: str | None) -> str:
    safe = "".join(c if c.isalnum() else "_" for c in stem)
    suffix = f"__{sheet}" if sheet else ""
    return f"{safe}{suffix}.parquet"


def parse_csv(
    upload_path: Path,
    parquet_dir: Path,
    normalize_columns: bool = False,
    options: ReadOptions = DEFAULT_READ_OPTIONS,
) -> ParseResult:
    parquet_dir.mkdir(parents=True, exist_ok=True)
    out = parquet_dir / _parquet_name(upload_path.stem, None)
    if options.is_default:
        # CSVWriter infers the delimiter via Datagrunt, then writes Parquet.
        CSVWriter(str(upload_path), normalize_columns=normalize_columns).write_parquet(str(out))
    else:
        # CSVWriter.write_parquet takes no read options; parse with the
        # reader (kwargs override auto preamble detection) and write the
        # frame. Columns stay VARCHAR — Studio's DuckDB layer owns casting.
        df = CSVReader(str(upload_path), engine="polars", normalize_columns=normalize_columns).to_dataframe(
            **_csv_read_kwargs(options)
        )
        df.write_parquet(out)
    return ParseResult(sheet=None, parquet_path=out)


def list_excel_sheets(upload_path: Path) -> list[str]:
    return list(ExcelReader(str(upload_path)).sheets)


def parse_excel(
    upload_path: Path,
    parquet_dir: Path,
    sheet: str | None = None,
    normalize_columns: bool = False,
    sheet_options: dict[str, ReadOptions] | None = None,
) -> list[ParseResult]:
    parquet_dir.mkdir(parents=True, exist_ok=True)
    sheets = [sheet] if sheet is not None else list_excel_sheets(upload_path)
    results: list[ParseResult] = []
    writer = ExcelWriter(str(upload_path), normalize_columns=normalize_columns)
    for sheet_name in sheets:
        out = parquet_dir / _parquet_name(upload_path.stem, sheet_name)
        opts = (sheet_options or {}).get(sheet_name, DEFAULT_READ_OPTIONS)
        writer.write_parquet(str(out), sheet=sheet_name, **_excel_read_kwargs(opts))
        results.append(ParseResult(sheet=sheet_name, parquet_path=out))
    return results


def preview_file(upload_path: Path, max_rows: int = 5) -> dict:
    if upload_path.suffix.lower() in _EXCEL_SUFFIXES:
        sheets = list(ExcelReader(str(upload_path)).sheets)
        sheet = sheets[0] if sheets else None
        return {"sheets": sheets, **preview_with_options(upload_path, sheet=sheet, max_rows=max_rows)}
    return {"sheets": None, **preview_with_options(upload_path, max_rows=max_rows)}


def convert_file(upload_path: Path, out_path: Path, fmt: str) -> Path:
    out_path.parent.mkdir(parents=True, exist_ok=True)
    is_excel = upload_path.suffix.lower() in _EXCEL_SUFFIXES
    writer = ExcelWriter(str(upload_path)) if is_excel else CSVWriter(str(upload_path))
    method = {
        "csv": writer.write_csv,
        "json": writer.write_json,
        "parquet": writer.write_parquet,
        "excel": writer.write_excel,
    }[fmt]
    method(str(out_path))
    return out_path


def parquet_to_csv(parquet_path: Path, out_path: Path) -> Path:
    """Convert a parquet file to CSV with datagrunt's native writer."""
    ParquetWriter(str(parquet_path)).write_csv(str(out_path))
    return out_path


def parquet_to_json(parquet_path: Path, out_path: Path) -> Path:
    """Convert a parquet file to JSON with datagrunt's native writer."""
    ParquetWriter(str(parquet_path)).write_json(str(out_path))
    return out_path
