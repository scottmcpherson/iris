"""Inbound route registration for the Iris Hermes platform adapter."""

from __future__ import annotations


def register_inbound_routes(app, adapter) -> None:
    app.router.add_get("/health", adapter._inbound_health)
    app.router.add_get("/iris/models", adapter._inbound_models)
    app.router.add_get("/iris/slash-commands", adapter._inbound_slash_commands)
    app.router.add_post("/iris/slash-complete", adapter._inbound_slash_complete)
    app.router.add_post("/iris/messages", adapter._inbound_message)
