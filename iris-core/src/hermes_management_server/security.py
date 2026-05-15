"""Authentication helpers for the management API."""

from __future__ import annotations

import hashlib
import ipaddress
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


def device_token_hash(token: str) -> str:
    digest = hashlib.sha256(f"iris-core-device-token:v1:{token}".encode("utf-8")).hexdigest()
    return f"v1:{digest}"


def host_is_loopback(host: str) -> bool:
    value = (host or "").strip().lower()
    if value in {"", "localhost", "127.0.0.1", "::1"}:
        return True
    try:
        return ipaddress.ip_address(value).is_loopback
    except ValueError:
        return False


def make_auth_dependency(token_state_key: str = "management_token") -> Callable[[Request, HTTPAuthorizationCredentials | None], None]:
    async def require_bearer_token(
        request: Request,
        credentials: Annotated[HTTPAuthorizationCredentials | None, Depends(bearer_scheme)],
    ) -> None:
        token = str(getattr(request.app.state, token_state_key, "") or "")
        settings = getattr(request.app.state, "settings", None)
        requires_auth = not host_is_loopback(str(getattr(settings, "host", "127.0.0.1")))
        if not token and not requires_auth:
            if credentials is not None:
                device = active_device_for_credentials(request, credentials)
                if device:
                    request.state.iris_device = device
                    return
                raise ManagementError("Bearer token is invalid.", status_code=401)
            return
        if credentials is None or credentials.scheme.lower() != "bearer":
            raise ManagementError("Bearer token is required.", status_code=401)
        if token and secrets.compare_digest(credentials.credentials, token):
            request.state.iris_device = {
                "id": "management-token",
                "name": "Management token",
                "kind": "admin",
            }
            return
        device = active_device_for_credentials(request, credentials)
        if device:
            request.state.iris_device = device
            return
        raise ManagementError("Bearer token is invalid.", status_code=401)

    return require_bearer_token


def active_device_for_credentials(
    request: Request,
    credentials: HTTPAuthorizationCredentials | None,
) -> dict | None:
    if credentials is None or credentials.scheme.lower() != "bearer":
        return None
    core_store = getattr(request.app.state, "core_store", None)
    if core_store is None:
        return None
    device = core_store.active_device_for_token_hash(device_token_hash(credentials.credentials))
    if device:
        core_store.touch_device(device["id"])
    return device
