from pathlib import Path

import duckdb
import pytest

from app import datagrunt_service as svc

FIXTURES = Path(__file__).parent / "fixtures"

# datagrunt 4.5.4 deprecation-warns on the read_options dict spelling, but it
# is the only spelling pl.read_excel accepts for calamine options — tracked in
# https://github.com/pmgraham/datagrunt/issues/290. Tolerated until resolved.
_READ_OPTIONS_DEPRECATION = "ignore:Passing 'read_options' as a dictionary is deprecated:DeprecationWarning"


def _read_parquet_rows(parquet_path: Path) -> list[tuple]:
    con = duckdb.connect()
    return con.execute(f"SELECT * FROM read_parquet('{parquet_path.as_posix()}')").fetchall()


def test_parse_csv_infers_semicolon_delimiter(tmp_path):
    result = svc.parse_csv(FIXTURES / "semicolon.csv", tmp_path)
    assert result.sheet is None
    assert result.parquet_path.exists()
    rows = _read_parquet_rows(result.parquet_path)
    assert len(rows) == 2  # delimiter inferred, not 1 ragged column


def test_list_excel_sheets():
    sheets = svc.list_excel_sheets(FIXTURES / "two_sheets.xlsx")
    assert sheets == ["east", "west"]


def test_parse_excel_all_sheets(tmp_path):
    results = svc.parse_excel(FIXTURES / "two_sheets.xlsx", tmp_path)
    assert {r.sheet for r in results} == {"east", "west"}
    for r in results:
        assert r.parquet_path.exists()


def test_convert_file_to_parquet(tmp_path):
    out = svc.convert_file(FIXTURES / "semicolon.csv", tmp_path / "out.parquet", "parquet")
    assert out.exists()
    assert len(_read_parquet_rows(out)) == 2


def test_preview_file():
    preview = svc.preview_file(FIXTURES / "semicolon.csv")
    assert preview["sheets"] is None
    assert len(preview["columns"]) > 0
    assert len(preview["columns_normalized"]) > 0
    assert len(preview["rows"]) == 2


def test_parquet_to_csv_roundtrip(tmp_path):
    src = tmp_path / "src.parquet"
    con = duckdb.connect()
    con.execute("CREATE TABLE t AS SELECT * FROM range(5) r(n)")
    con.execute(f"COPY t TO '{src.as_posix()}' (FORMAT PARQUET)")

    out = svc.parquet_to_csv(src, tmp_path / "out.csv")

    lines = out.read_text().strip().splitlines()
    assert lines[0] == "n"  # header from the parquet schema
    assert len(lines) == 6  # header + 5 rows
    assert lines[1] == "0"


def test_preview_with_options_csv_skip_rows():
    result = svc.preview_with_options(FIXTURES / "preamble.csv", options=svc.ReadOptions(skip_rows=3))
    assert result["columns"] == ["name", "amount"]
    assert result["rows"] == [["alice", "10"], ["bob", "20"]]


def test_preview_with_options_csv_no_header():
    result = svc.preview_with_options(FIXTURES / "preamble.csv", options=svc.ReadOptions(skip_rows=3, has_header=False))
    assert result["columns"] == ["column_1", "column_2"]
    assert result["rows"][0] == ["name", "amount"]


def test_preview_with_options_excel_header_on_row_4():
    result = svc.preview_with_options(
        FIXTURES / "preamble_two_sheets.xlsx",
        options=svc.ReadOptions(skip_rows=3),
        sheet="messy",
    )
    assert result["columns"] == ["name", "amount"]
    assert result["rows"] == [["alice", "10"], ["bob", "20"]]


def test_preview_with_options_excel_no_header():
    result = svc.preview_with_options(
        FIXTURES / "preamble_two_sheets.xlsx",
        options=svc.ReadOptions(skip_rows=3, has_header=False),
        sheet="messy",
    )
    assert result["rows"][0] == ["name", "amount"]


def test_preview_with_options_defaults_match_preview_file():
    legacy = svc.preview_file(FIXTURES / "two_sheets.xlsx")
    fresh = svc.preview_with_options(FIXTURES / "two_sheets.xlsx", sheet="east")
    assert fresh["columns"] == legacy["columns"]
    assert fresh["rows"] == legacy["rows"]


def test_preview_with_options_normalized_columns_follow_options():
    result = svc.preview_with_options(FIXTURES / "preamble.csv", options=svc.ReadOptions(skip_rows=3))
    assert result["columns_normalized"] == ["name", "amount"]


def test_preview_with_options_skip_past_end_raises():
    with pytest.raises(Exception):
        svc.preview_with_options(FIXTURES / "preamble.csv", options=svc.ReadOptions(skip_rows=999))


def _read_parquet_columns(parquet_path: Path) -> list[str]:
    con = duckdb.connect()
    rel = con.execute(f"SELECT * FROM read_parquet('{parquet_path.as_posix()}') LIMIT 0")
    return [d[0] for d in rel.description]


def test_parse_csv_with_skip_rows(tmp_path):
    result = svc.parse_csv(FIXTURES / "preamble.csv", tmp_path, options=svc.ReadOptions(skip_rows=3))
    assert _read_parquet_columns(result.parquet_path) == ["name", "amount"]
    assert _read_parquet_rows(result.parquet_path) == [("alice", "10"), ("bob", "20")]


def test_parse_csv_skip_rows_with_normalize(tmp_path):
    result = svc.parse_csv(
        FIXTURES / "preamble.csv",
        tmp_path,
        normalize_columns=True,
        options=svc.ReadOptions(skip_rows=3),
    )
    assert _read_parquet_columns(result.parquet_path) == ["name", "amount"]


def test_parse_csv_default_options_unchanged(tmp_path):
    result = svc.parse_csv(FIXTURES / "semicolon.csv", tmp_path)
    assert len(_read_parquet_rows(result.parquet_path)) == 2


@pytest.mark.filterwarnings(_READ_OPTIONS_DEPRECATION)
def test_parse_excel_per_sheet_options(tmp_path):
    results = svc.parse_excel(
        FIXTURES / "preamble_two_sheets.xlsx",
        tmp_path,
        sheet_options={"messy": svc.ReadOptions(skip_rows=3)},
    )
    by_sheet = {r.sheet: r for r in results}
    assert _read_parquet_columns(by_sheet["messy"].parquet_path) == ["name", "amount"]
    assert _read_parquet_rows(by_sheet["messy"].parquet_path) == [("alice", "10"), ("bob", "20")]
    # untouched sheet keeps default parsing
    assert _read_parquet_columns(by_sheet["clean"].parquet_path) == ["name", "amount"]
    assert _read_parquet_rows(by_sheet["clean"].parquet_path) == [("carol", "30"), ("dave", "40")]


@pytest.mark.filterwarnings(_READ_OPTIONS_DEPRECATION)
def test_parse_excel_no_header(tmp_path):
    results = svc.parse_excel(
        FIXTURES / "preamble_two_sheets.xlsx",
        tmp_path,
        sheet="messy",
        sheet_options={"messy": svc.ReadOptions(skip_rows=3, has_header=False)},
    )
    rows = _read_parquet_rows(results[0].parquet_path)
    assert rows[0] == ("name", "amount")


@pytest.mark.filterwarnings(_READ_OPTIONS_DEPRECATION)
def test_parse_excel_options_keep_all_rows_past_sample_cap(tmp_path):
    """Guard against sample-capped reads: non-default options must import
    EVERY row, not datagrunt's 20-row preview sample."""
    import polars as pl

    src = tmp_path / "many_rows.xlsx"
    pl.DataFrame(
        {
            "a": ["Report", "name"] + [f"person_{i}" for i in range(25)],
            "b": [None, "amount"] + [str(i) for i in range(25)],
        }
    ).write_excel(str(src), worksheet="data", include_header=False, autofit=False)

    results = svc.parse_excel(
        src,
        tmp_path / "out",
        sheet_options={"data": svc.ReadOptions(skip_rows=1)},
    )
    rows = _read_parquet_rows(results[0].parquet_path)
    assert len(rows) == 25
    assert rows[0] == ("person_0", "0")
    assert rows[-1] == ("person_24", "24")
