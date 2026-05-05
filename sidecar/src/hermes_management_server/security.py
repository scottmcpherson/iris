"""Authentication helpers for the management API."""

from __future__ import annotations

import secrets
from collections.abc import Callable
from typing import Annotated

from fastapi import Depends, Request
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer


class ManagementError(Exception):
    """Structured API error that should be returned as JSON."""

    def __init__(self, error: str, status_code: int = 400) -> None:
        super().__init__(error)
        self.error = error
        self.status_code = status_code


bearer_scheme = HTTPBearer(auto_error=False)


def make_auth_dependency() -> Callable[[Request, HTTPAuthorizationCredentials | None], None]:
    async def require_bearer_token(
        request: Request,
        credentials: Annotated[HTTPAuthorizationCredentials | None, Depends(bearer_scheme)],
    ) -> None:
        token = str(getattr(request.app.state, "management_token", "") or "")
        if not token:
            return
        if credentials is None or credentials.scheme.lower() != "bearer":
            raise ManagementError("Bearer token is required.", status_code=401)
        if not secrets.compare_digest(credentials.credentials, token):
            raise ManagementError("Bearer token is invalid.", status_code=401)

    return require_bearer_token
