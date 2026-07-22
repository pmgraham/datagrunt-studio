import duckdb
import pytest

from app import sql_builder as sb


@pytest.fixture
def con():
    c = duckdb.connect()
    c.execute("CREATE TABLE t(id INTEGER, name VARCHAR, price DOUBLE)")
    c.execute("INSERT INTO t VALUES (1,'a',10.0),(1,'a',10.0),(2,NULL,NULL)")
    c.execute("CREATE TABLE r(id INTEGER, region VARCHAR)")
    c.execute("INSERT INTO r VALUES (1,'East'),(2,'West')")
    return c


def test_drop_null_sql_runs(con):
    sql = sb.build_clean_sql("t", "drop_null", column="name")
    rows = con.sql(sql).fetchall()
    assert all(row[1] is not None for row in rows)


def test_fill_null_numeric(con):
    sql = sb.build_clean_sql("t", "fill_null", column="price", value="0")
    rows = con.sql(sql + " ORDER BY id").fetchall()
    assert rows[-1][2] == 0.0


def test_rename_column(con):
    sql = sb.build_clean_sql("t", "rename", column="name", new_name="label")
    assert "label" in con.sql(sql).columns
    assert "name" not in con.sql(sql).columns


def test_cast_type(con):
    sql = sb.build_clean_sql("t", "cast", column="id", cast_type="VARCHAR")
    types = dict(zip(con.sql(sql).columns, con.sql(sql).types))
    assert "VARCHAR" in str(types["id"]).upper()


def test_dedup(con):
    sql = sb.build_clean_sql("t", "dedup")
    assert len(con.sql(sql).fetchall()) == 2


def test_join_inner(con):
    sql = sb.build_join_sql("t", "r", "id", "id", "inner")
    rows = con.sql(sql).fetchall()
    assert len(rows) >= 2


def test_clean_rejects_bad_op():
    with pytest.raises(ValueError):
        sb.build_clean_sql("t", "explode")


def test_snippet_for_load_csv():
    snippet = sb.snippet_for_load("sales", "raw_sales_data.csv", "csv")
    assert "CSVReader('raw_sales_data.csv')" in snippet


def test_snippet_for_load_cleaned():
    snippet = sb.snippet_for_load("sales_cleaned", "users_cleaned", "cleaned")
    assert "Materialized cleansed table" in snippet
    assert "sales_cleaned" in snippet


def test_clean_pipeline_runs(con):
    class Step:
        def __init__(self, op, column=None, value=None, newName=None, castType=None):
            self.op = op
            self.column = column
            self.value = value
            self.newName = newName
            self.castType = castType

    steps = [
        Step("drop_null", column="name"),
        Step("rename", column="name", newName="first_name"),
        Step("dedup"),
    ]
    sql = sb.build_clean_pipeline_sql("t", steps)
    res = con.sql(sql).fetchall()
    assert len(res) == 1
    assert "first_name" in con.sql(sql).columns


def test_fill_null_quoting_by_datatype(con):
    sql = sb.build_clean_sql("t", "fill_null", column="name", value="0", column_type="VARCHAR")
    assert "COALESCE(\"name\", '0')" in sql
    res = con.sql(sql).fetchall()
    assert res[-1][1] == "0"

    sql_numeric = sb.build_clean_sql("t", "fill_null", column="price", value="0", column_type="DOUBLE")
    assert 'COALESCE("price", 0)' in sql_numeric or 'COALESCE("price", 0.0)' in sql_numeric
    res_numeric = con.sql(sql_numeric).fetchall()
    assert res_numeric[-1][2] == 0.0
