"""Reject cross-site state-changing requests at the backend boundary.

The Next.js proxy applies the same rule, but this port is reachable on its
own: a browser can post to it directly, and any future client bypasses the
proxy entirely. Both layers enforce it independently.

CSRF is browser-mediated, so a request carrying neither ``Sec-Fetch-Site``
nor ``Origin`` is not forgeable and is allowed — that is the proxy's own
server-side fetch, ``scripts/smoke.sh``, and the test suite. Network-level
exposure is handled by binding to loopback, not here.
"""

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import JSONResponse
from starlette.types import ASGIApp

STATE_CHANGING_METHODS = frozenset({"POST", "PUT", "PATCH", "DELETE"})


def is_cross_site(sec_fetch_site: str | None, origin: str | None, self_origin: str) -> bool:
    """Whether a mutating request came from a different site."""
    if sec_fetch_site is not None:
        return sec_fetch_site != "same-origin"
    if origin is not None:
        return origin.rstrip("/") != self_origin.rstrip("/")
    return False


class OriginGuardMiddleware(BaseHTTPMiddleware):
    def __init__(self, app: ASGIApp) -> None:
        super().__init__(app)

    async def dispatch(self, request: Request, call_next):
        if request.method not in STATE_CHANGING_METHODS:
            return await call_next(request)

        self_origin = str(request.base_url).rstrip("/")
        if is_cross_site(
            request.headers.get("sec-fetch-site"),
            request.headers.get("origin"),
            self_origin,
        ):
            return JSONResponse(
                {"detail": "Cross-site requests are not allowed."},
                status_code=403,
            )

        return await call_next(request)
