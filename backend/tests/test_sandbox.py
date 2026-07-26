import duckdb
import pytest

from app.query_engine import QueryEngine


@pytest.fixture
def engine(tmp_path):
    return QueryEngine(tmp_path / "session.duckdb")


def _blocked_by_permission(results) -> bool:
    """True if run_statements reported the sandbox's PermissionException.

    run_statements() never lets a failing statement's exception escape the
    call — by design (see test_run_statements_captures_runtime_errors in
    test_query_engine.py, which asserts on `.error`/`.detail` rather than
    catching a raise) it always converts a failure into a StatementResult
    with those fields set. So the block must be observed there instead of
    via pytest.raises, which run_statements can never satisfy.
    """
    return results[0].error == duckdb.PermissionException.__name__


def test_reads_outside_the_data_dir_are_blocked(engine):
    results = engine.run_statements("SELECT * FROM read_text('/etc/hosts')")
    assert _blocked_by_permission(results)


def test_writes_outside_the_data_dir_are_blocked(engine, tmp_path):
    outside = tmp_path.parent / "escaped.csv"
    results = engine.run_statements(f"COPY (SELECT 1) TO '{outside.as_posix()}'")
    assert _blocked_by_permission(results)
    assert not outside.exists()


def test_attach_outside_the_data_dir_is_blocked(engine, tmp_path):
    results = engine.run_statements(f"ATTACH '{(tmp_path.parent / 'evil.duckdb').as_posix()}' AS evil")
    assert _blocked_by_permission(results)


def test_http_egress_is_blocked(engine):
    results = engine.run_statements("SELECT * FROM read_csv('https://example.com/x.csv')")
    assert _blocked_by_permission(results)


def test_the_sandbox_cannot_be_widened_from_session_sql(engine):
    widen_dirs = engine.run_statements("SET allowed_directories=['/']")
    assert widen_dirs[0].error is not None
    assert "locked" in (widen_dirs[0].detail or "").lower()

    widen_lock = engine.run_statements("SET lock_configuration=false")
    assert widen_lock[0].error is not None
    assert "locked" in (widen_lock[0].detail or "").lower()


def test_work_inside_the_data_dir_still_succeeds(engine, tmp_path):
    target = tmp_path / "ok.parquet"
    write_result = engine.run_statements(f"COPY (SELECT 1 AS a) TO '{target.as_posix()}' (FORMAT PARQUET)")
    assert write_result[0].error is None
    assert target.exists()

    read_result = engine.run_statements(f"SELECT * FROM read_parquet('{target.as_posix()}')")
    assert read_result[0].error is None
    assert read_result[0].rows == [[1]]
