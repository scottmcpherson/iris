"""Async HTTP client helpers for Iris Core calls."""

from __future__ import annotations

import asyncio
import json
import re
from typing import Any

try:
    import aiohttp

    AIOHTTP_AVAILABLE = True
except ImportError:
    aiohttp = None  # type: ignore[assignment]
    AIOHTTP_AVAILABLE = False


class IrisCoreHttpClient:
    def __init__(self, *, base_url: str, token: str, timeout_seconds: int = 8) -> None:
        self.base_url = base_url
        self.token = token
        self.timeout_seconds = timeout_seconds

    async def request(self, method: str, path: str, body: dict[str, Any] | None = None) -> dict[str, Any]:
        if not AIOHTTP_AVAILABLE:
            return {"ok": False, "error": "aiohttp is required for Iris Core requests", "retryable": False}

        url = f"{self.base_url}{path}"
        headers = {
            "Accept": "application/json",
            "Authorization": f"Bearer {self.token}",
        }
        if body is not None:
            headers["Content-Type"] = "application/json"
        timeout = aiohttp.ClientTimeout(total=self.timeout_seconds)  # type: ignore[union-attr]
        try:
            async with aiohttp.ClientSession(timeout=timeout) as session:  # type: ignore[union-attr]
                async with session.request(method, url, headers=headers, json=body if body is not None else None) as response:
                    text = await response.text(errors="replace")
                    if response.status >= 400:
                        return {"ok": False, "status": response.status, "error": api_error(text) or f"HTTP {response.status}"}
        except asyncio.CancelledError:
            raise
        except (aiohttp.ClientError, asyncio.TimeoutError) as exc:  # type: ignore[union-attr]
            return {"ok": False, "error": str(exc), "retryable": True}

        try:
            parsed = json.loads(text) if text else {}
        except json.JSONDecodeError as exc:
            return {"ok": False, "error": f"Invalid Iris JSON: {exc}"}
        if not isinstance(parsed, dict):
            return {"ok": False, "error": "Iris returned a non-object JSON response"}
        return parsed if parsed.get("ok") is False else {**parsed, "ok": True}


def api_error(text: str) -> str:
    try:
        parsed = json.loads(text)
    except json.JSONDecodeError:
        return re.sub(r"\s+", " ", text).strip()[:400]
    if isinstance(parsed, dict):
        return str(parsed.get("error") or parsed.get("detail") or "").strip()
    return ""
