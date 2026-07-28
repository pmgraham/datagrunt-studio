"""The client must never receive text derived from a caught exception.

Each test raises an exception whose message carries a sentinel absolute path,
standing in for the real leak: datagrunt and DuckDB quote the file they failed
on, and that file lives under the session's upload directory.
"""

import logging

import pytest
from fastapi import HTTPException

from app.error_reporting import http_error, sanitized_detail

SENTINEL_PATH = "/srv/secret-dir/upload.csv"


def _boom() -> ValueError:
    return ValueError(f"could not read {SENTINEL_PATH}: bad delimiter")


def test_sanitized_detail_returns_message_and_exception_type():
    detail = sanitized_detail("Could not parse the file.", _boom())
    assert detail == "Could not parse the file. (ValueError)"


def test_sanitized_detail_omits_the_exception_message():
    detail = sanitized_detail("Could not parse the file.", _boom())
    assert SENTINEL_PATH not in detail
    assert "bad delimiter" not in detail


def test_sanitized_detail_logs_the_full_exception(caplog):
    with caplog.at_level(logging.ERROR, logger="app.error_reporting"):
        sanitized_detail("Could not parse the file.", _boom())

    assert SENTINEL_PATH in caplog.text
    assert "bad delimiter" in caplog.text


def test_sanitized_detail_logs_a_traceback(caplog):
    with caplog.at_level(logging.ERROR, logger="app.error_reporting"):
        try:
            raise _boom()
        except ValueError as exc:
            sanitized_detail("Could not parse the file.", exc)

    record = caplog.records[0]
    assert record.exc_info[2] is not None


def test_http_error_carries_status_and_sanitized_detail():
    error = http_error(502, "GCS request failed.", _boom())

    assert isinstance(error, HTTPException)
    assert error.status_code == 502
    assert error.detail == "GCS request failed. (ValueError)"
    assert SENTINEL_PATH not in error.detail


def test_http_error_is_raisable():
    with pytest.raises(HTTPException) as caught:
        raise http_error(500, "Extraction failed.", _boom())

    assert caught.value.status_code == 500
