"""Authentication helpers for the management API."""

from __future__ import annotations

import ipaddress
import hashlib
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
DEVICE_TOKEN_PREFIX = "iris_mobile_"


def host_is_loopback(host: str) -> bool:
    value = (host or "").strip().lower()
    if value in {"", "localhost", "127.0.0.1", "::1"}:
        return True
    try:
        return ipaddress.ip_address(value).is_loopback
    except ValueError:
        return False


def device_token_hash(token: str) -> str:
    return "v1:" + hashlib.sha256(f"iris-core-device-token:v1:{token}".encode("utf-8")).hexdigest()


def device_token_hash_is_valid(value: str) -> bool:
    prefix = "v1:"
    digest = value.removeprefix(prefix)
    return value.startswith(prefix) and len(digest) == 64 and all(char in "0123456789abcdef" for char in digest.lower())


def make_auth_dependency(token_state_key: str = "management_token") -> Callable[[Request, HTTPAuthorizationCredentials | None], None]:
    async def require_bearer_token(
        request: Request,
        credentials: Annotated[HTTPAuthorizationCredentials | None, Depends(bearer_scheme)],
    ) -> None:
        token = str(getattr(request.app.state, token_state_key, "") or "")
        settings = getattr(request.app.state, "settings", None)
        bind_host = str(getattr(settings, "host", "127.0.0.1"))
        client_host = str(getattr(request.client, "host", "") or "")
        requires_auth = not host_is_loopback(bind_host) and not host_is_loopback(client_host)
        if not requires_auth:
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
        raw_device_token = credentials.credentials.strip()
        if raw_device_token.startswith(DEVICE_TOKEN_PREFIX):
            core_store = getattr(request.app.state, "core_store", None)
            device = core_store.get_device_by_token_hash(device_token_hash(raw_device_token)) if core_store else None
            if device:
                core_store.touch_device(str(device["id"]))
                request.state.iris_device = device
                return
        raise ManagementError("Bearer token is invalid.", status_code=401)

    return require_bearer_token
