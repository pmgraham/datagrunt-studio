"""Curated API errors that keep exception text out of responses.

A caught exception's message routinely carries a server filesystem path —
datagrunt and DuckDB quote the file they failed on, and that file lives under
the session's private data directory. Returning that text to the client leaks
the server's layout, so every error the API returns is hand-written here and
the original exception goes to the log instead.

This generalizes what `gcs_service.GcsCredentialsError` already does: it
substitutes a fixed hint for the underlying `DefaultCredentialsError`, whose
message embeds the ADC file path.
"""

import logging

from fastapi import HTTPException

logger = logging.getLogger(__name__)


def sanitized_detail(message: str, exc: BaseException) -> str:
    """Log `exc` in full; return `message` tagged with the exception's type.

    The type is a code identifier (`ParserError`, `DuckDBError`), not runtime
    data, so it is safe to return and is often the only clue a reader needs to
    tell one failure mode from another.
    """
    logger.error("%s: %s", message, exc, exc_info=exc)
    return f"{message} ({type(exc).__name__})"


def http_error(status_code: int, message: str, exc: BaseException) -> HTTPException:
    """Build an HTTPException whose detail is safe to return to the client."""
    return HTTPException(status_code=status_code, detail=sanitized_detail(message, exc))
