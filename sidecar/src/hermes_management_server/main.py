"""FastAPI application and CLI entrypoint."""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import secrets
from dataclasses import dataclass
from typing import Any

import uvicorn
from fastapi import Depends, FastAPI, Query, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.responses import StreamingResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

from .core_store import (
    DEFAULT_RUNTIME_ID,
    CoreStore,
    chat_id_for_conversation,
    clamp_int,
    core_message_from_hermes,
    now,
    random_id,
)
from .hermes_store import HermesStore, checked_at, normalize_hermes_home
from .inbox_store import InboxStore
from .models import (
    ConversationDetailResponse,
    ConversationsResponse,
    CoreAutomationCreateRequest,
    CoreAutomationUpdateRequest,
    CoreConversationCreateRequest,
    DeviceCursorUpdateRequest,
    DevicePairRequest,
    CoreMessageCreateRequest,
    ErrorResponse,
    HealthResponse,
    InboxHealthResponse,
    InboxMessageCreateRequest,
    InboxMessageResponse,
    InboxMessagesResponse,
    ProfileActionResponse,
    ProfileCloneRequest,
    ProfileCreateRequest,
    MemoryResponse,
    ProfileResponse,
    ProfilesResponse,
    RuntimeDeliveryHermesRequest,
    SkillDetailResponse,
    SkillsResponse,
    StatusResponse,
)
from .runtime_registry import RuntimeRegistry
from .security import ManagementError, device_token_hash, host_is_loopback, make_auth_dependency


DEFAULT_CORS_ORIGINS = (
    "tauri://localhost",
    "http://localhost:1420",
    "http://127.0.0.1:1420",
)


@dataclass(frozen=True)
class Settings:
    hermes_home: str | None = None
    host: str = "127.0.0.1"
    port: int = 8765
    token: str | None = None
    inbox_token: str | None = None
    runtime_delivery_token: str | None = None
    inbox_store_path: str | None = None
    core_store_path: str | None = None
    cors_origins: tuple[str, ...] = ()

    @classmethod
    def from_env(cls) -> "Settings":
        return cls(
            hermes_home=os.environ.get("HERMES_HOME") or None,
            host=os.environ.get("IRIS_CORE_HOST") or os.environ.get("HERMES_MGMT_HOST") or "127.0.0.1",
            port=parse_port(os.environ.get("IRIS_CORE_PORT") or os.environ.get("HERMES_MGMT_PORT"), 8765),
            token=os.environ.get("IRIS_CORE_TOKEN") or os.environ.get("HERMES_MGMT_TOKEN") or None,
            inbox_token=os.environ.get("IRIS_INBOX_TOKEN") or os.environ.get("AGENTUI_INBOX_TOKEN") or None,
            runtime_delivery_token=(
                os.environ.get("IRIS_RUNTIME_DELIVERY_TOKEN")
                or os.environ.get("AGENTUI_RUNTIME_DELIVERY_TOKEN")
                or None
            ),
            inbox_store_path=os.environ.get("IRIS_INBOX_STORE") or os.environ.get("AGENTUI_INBOX_STORE") or None,
            core_store_path=os.environ.get("IRIS_CORE_STORE") or os.environ.get("AGENTUI_CORE_STORE") or None,
            cors_origins=parse_cors_origins(
                os.environ.get("IRIS_CORE_CORS_ORIGINS") or os.environ.get("HERMES_MGMT_CORS_ORIGINS")
            ) or DEFAULT_CORS_ORIGINS,
        )


def parse_port(value: str | None, default: int) -> int:
    if not value:
        return default
    try:
        port = int(value)
    except ValueError as exc:
        raise SystemExit(f"Invalid port: {value}") from exc
    if port < 1 or port > 65535:
        raise SystemExit(f"Port must be between 1 and 65535: {port}")
    return port


def parse_cors_origins(value: str | None) -> tuple[str, ...]:
    if not value:
        return ()
    return tuple(origin.strip() for origin in value.split(",") if origin.strip())


def agentui_platform_token(hermes_home: os.PathLike[str] | str) -> str:
    return (
        os.environ.get("IRIS_TOKEN", "").strip()
        or os.environ.get("AGENTUI_TOKEN", "").strip()
        or os.environ.get("IRIS_INBOX_TOKEN", "").strip()
        or os.environ.get("AGENTUI_INBOX_TOKEN", "").strip()
        or env_file_value(os.path.join(os.fspath(hermes_home), ".env"), "IRIS_TOKEN")
        or env_file_value(os.path.join(os.fspath(hermes_home), ".env"), "AGENTUI_TOKEN")
        or env_file_value(os.path.join(os.fspath(hermes_home), ".env"), "IRIS_INBOX_TOKEN")
        or env_file_value(os.path.join(os.fspath(hermes_home), ".env"), "AGENTUI_INBOX_TOKEN")
    )


def hermes_api_token(hermes_home: os.PathLike[str] | str) -> str:
    return (
        os.environ.get("HERMES_API_TOKEN", "").strip()
        or os.environ.get("HERMES_REMOTE_TOKEN", "").strip()
        or env_file_value(os.path.join(os.fspath(hermes_home), ".env"), "HERMES_API_TOKEN")
        or env_file_value(os.path.join(os.fspath(hermes_home), ".env"), "HERMES_REMOTE_TOKEN")
        or env_file_value(os.path.join(os.fspath(hermes_home), ".env"), "API_SERVER_KEY")
    )


def env_file_value(path: str, key: str) -> str:
    try:
        with open(path, encoding="utf-8") as handle:
            text = handle.read()
    except OSError:
        return ""
    prefix = f"{key}="
    for line in text.splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#") or not stripped.startswith(prefix):
            continue
        return stripped[len(prefix):].strip().strip("\"'")
    return ""


def model_switch_command(value: Any) -> str:
    if not isinstance(value, dict):
        return ""
    model = str(value.get("model") or "").strip()
    if not model:
        return ""
    provider = str(value.get("provider") or "").strip()
    return f"/model {model}{f' --provider {provider}' if provider else ''}"


def create_app(settings: Settings | None = None) -> FastAPI:
    app_settings = settings or Settings.from_env()
    store = HermesStore(app_settings.hermes_home)
    core_store = CoreStore(app_settings.core_store_path)
    app = FastAPI(
        title="Iris Core",
        version="0.1.0",
        docs_url=None,
        redoc_url=None,
        default_response_class=JSONResponse,
        responses={400: {"model": ErrorResponse}, 401: {"model": ErrorResponse}, 404: {"model": ErrorResponse}},
    )
    app.state.store = store
    app.state.core_store = core_store
    app.state.inbox_store = InboxStore(app_settings.inbox_store_path)
    app.state.settings = app_settings
    platform_token = agentui_platform_token(store.root)
    app.state.management_token = app_settings.token or ""
    app.state.inbox_token = app_settings.inbox_token or app_settings.token or platform_token or ""
    app.state.runtime_delivery_token = (
        app_settings.runtime_delivery_token
        or app_settings.inbox_token
        or app_settings.token
        or platform_token
        or ""
    )
    app.state.runtime_registry = RuntimeRegistry(
        core_store=core_store,
        hermes_store=store,
        management_url=f"http://{app_settings.host}:{app_settings.port}",
        agentui_token=platform_token,
        hermes_api_token=hermes_api_token(store.root),
    )
    app.state.runtime_registry.ensure_default_runtime()

    if app_settings.cors_origins:
        app.add_middleware(
            CORSMiddleware,
            allow_origins=list(app_settings.cors_origins),
            allow_credentials=True,
            allow_methods=["GET", "POST", "PATCH", "DELETE"],
            allow_headers=["Authorization", "Content-Type"],
        )

    @app.exception_handler(ManagementError)
    async def management_error_handler(_request, exc: ManagementError) -> JSONResponse:
        return JSONResponse(status_code=exc.status_code, content={"ok": False, "error": exc.error})

    @app.exception_handler(StarletteHTTPException)
    async def http_error_handler(_request, exc: StarletteHTTPException) -> JSONResponse:
        error = str(exc.detail or "Request failed.")
        return JSONResponse(status_code=exc.status_code, content={"ok": False, "error": error})

    @app.exception_handler(RequestValidationError)
    async def validation_error_handler(_request, exc: RequestValidationError) -> JSONResponse:
        return JSONResponse(status_code=422, content={"ok": False, "error": str(exc)})

    @app.exception_handler(Exception)
    async def unexpected_error_handler(_request, _exc: Exception) -> JSONResponse:
        return JSONResponse(status_code=500, content={"ok": False, "error": "Internal server error."})

    require_auth = make_auth_dependency()
    require_inbox_auth = make_auth_dependency("inbox_token")
    require_runtime_delivery_auth = make_auth_dependency("runtime_delivery_token")

    @app.get("/health", response_model=HealthResponse)
    async def health(_auth: None = Depends(require_auth)) -> HealthResponse:
        return HealthResponse(
            checkedAt=checked_at(),
            hermesHome=str(store.root),
            profilesRootExists=store.profiles_root.is_dir(),
        )

    @app.get("/v1/health")
    async def core_health(_auth: None = Depends(require_auth)) -> dict[str, Any]:
        return {
            "ok": True,
            "checkedAt": checked_at(),
            "service": "iris-core",
            "hermesHome": str(store.root),
            "profilesRootExists": store.profiles_root.is_dir(),
            "core": core_store.health(),
        }

    @app.get("/v1/devices")
    async def core_devices(_auth: None = Depends(require_auth)) -> dict[str, Any]:
        return {"ok": True, "devices": core_store.list_devices()}

    @app.get("/v1/devices/me")
    async def core_current_device(request: Request, _auth: None = Depends(require_auth)) -> dict[str, Any]:
        device = getattr(request.state, "agentui_device", None)
        return {
            "ok": True,
            "device": device if isinstance(device, dict) else None,
            "auth": core_auth_payload(request.app),
        }

    @app.post("/v1/devices/pair")
    async def core_pair_device(pairing: DevicePairRequest, _auth: None = Depends(require_auth)) -> dict[str, Any]:
        raw_token = f"agui_{secrets.token_urlsafe(32)}"
        device = core_store.create_device(
            name=pairing.name,
            kind=pairing.kind,
            token_hash=device_token_hash(raw_token),
            metadata=pairing.metadata,
        )
        return {
            "ok": True,
            "device": device,
            "token": raw_token,
            "tokenShownOnce": True,
        }

    @app.delete("/v1/devices/{device_id}")
    async def core_revoke_device(device_id: str, _auth: None = Depends(require_auth)) -> dict[str, Any]:
        if device_id == "management-token":
            raise ManagementError("The management token cannot be revoked through the device API.", status_code=400)
        device = core_store.revoke_device(device_id)
        if not device:
            raise ManagementError("Device was not found.", status_code=404)
        return {"ok": True, "device": device}

    @app.post("/v1/devices/me/cursors")
    async def core_update_device_cursor(
        cursor: DeviceCursorUpdateRequest,
        request: Request,
        _auth: None = Depends(require_auth),
    ) -> dict[str, Any]:
        device = getattr(request.state, "agentui_device", None)
        device_id = str(device.get("id") or "") if isinstance(device, dict) else ""
        if not device_id.startswith("dev_"):
            raise ManagementError("A paired device token is required for device cursors.", status_code=401)
        return {
            "ok": True,
            "cursor": core_store.upsert_device_cursor(device_id, cursor.streamName, cursor.lastCursor),
        }

    @app.get("/v1/inbox/health", response_model=InboxHealthResponse)
    async def inbox_health(
        request: Request,
        _auth: None = Depends(require_inbox_auth),
    ) -> InboxHealthResponse:
        result = request.app.state.inbox_store.health()
        return InboxHealthResponse(**result)

    @app.post("/v1/inbox/messages", response_model=InboxMessageResponse)
    async def inbox_create_message(
        message: InboxMessageCreateRequest,
        request: Request,
        _auth: None = Depends(require_inbox_auth),
    ) -> InboxMessageResponse:
        result = request.app.state.inbox_store.create_message(dump_model(message))
        mirror_inbox_message_to_core(request.app, result)
        return InboxMessageResponse(message=result)

    @app.get("/v1/inbox/messages", response_model=InboxMessagesResponse)
    async def inbox_messages(
        request: Request,
        after: int = Query(0),
        limit: int = Query(50),
        profile: str | None = Query(None),
        _auth: None = Depends(require_inbox_auth),
    ) -> InboxMessagesResponse:
        result = request.app.state.inbox_store.list_messages(after=after, limit=limit, profile=profile)
        return InboxMessagesResponse(**result)

    @app.post("/v1/inbox/messages/{message_id}/ack", response_model=InboxMessageResponse)
    async def inbox_ack_message(
        message_id: str,
        request: Request,
        _auth: None = Depends(require_inbox_auth),
    ) -> InboxMessageResponse:
        result = request.app.state.inbox_store.acknowledge_message(message_id)
        return InboxMessageResponse(message=result["message"])

    @app.get("/v1/status", response_model=StatusResponse)
    async def status(_auth: None = Depends(require_auth)) -> StatusResponse:
        profiles = store.profiles()
        return StatusResponse(
            checkedAt=checked_at(),
            hermesHome=str(store.root),
            activeProfile=store.active_profile_name(),
            profileCount=len(profiles),
            core=core_status_payload(request_app=app),
        )

    @app.get("/v1/runtimes")
    async def runtimes(_auth: None = Depends(require_auth)) -> dict[str, Any]:
        return {"ok": True, "runtimes": app.state.runtime_registry.runtimes()}

    @app.get("/v1/runtimes/{runtime_id}")
    async def runtime_detail(runtime_id: str, _auth: None = Depends(require_auth)) -> dict[str, Any]:
        runtime = app.state.runtime_registry.runtime(runtime_id)
        if not runtime:
            raise ManagementError("Runtime was not found.", status_code=404)
        return {"ok": True, "runtime": runtime}

    @app.post("/v1/runtimes/{runtime_id}/probe")
    async def runtime_probe(runtime_id: str, _auth: None = Depends(require_auth)) -> dict[str, Any]:
        runtime = app.state.runtime_registry.runtime(runtime_id)
        if not runtime:
            raise ManagementError("Runtime was not found.", status_code=404)
        profile = "default"
        agent = next((row for row in app.state.runtime_registry.agents() if row["runtimeId"] == runtime_id and row["isDefault"]), None)
        if agent:
            profile = agent["runtimeProfile"]
        probe = app.state.runtime_registry.probe(runtime_id, profile=profile)
        return {"ok": True, "runtime": runtime, "probe": probe}

    @app.get("/v1/agents")
    async def agents(_auth: None = Depends(require_auth)) -> dict[str, Any]:
        return {"ok": True, "agents": app.state.runtime_registry.agents()}

    @app.get("/v1/agents/{agent_id}")
    async def agent_detail(agent_id: str, _auth: None = Depends(require_auth)) -> dict[str, Any]:
        agent = app.state.runtime_registry.agent(agent_id)
        if not agent:
            raise ManagementError("Agent was not found.", status_code=404)
        return {"ok": True, "agent": agent}

    @app.get("/v1/conversations")
    async def core_conversations(
        agentId: str | None = Query(None),
        limit: int = Query(80),
        cursor: int = Query(0),
        _auth: None = Depends(require_auth),
    ) -> dict[str, Any]:
        del cursor
        limit = clamp_int(limit, default=80, minimum=1, maximum=200)
        if agentId and not app.state.runtime_registry.agent(agentId):
            raise ManagementError("Agent was not found.", status_code=404)
        sync_core_conversations(app, agentId, limit)
        return {
            "ok": True,
            "conversations": core_store.list_conversations(agent_id=agentId, limit=limit),
        }

    @app.post("/v1/conversations")
    async def core_create_conversation(
        request: CoreConversationCreateRequest,
        _auth: None = Depends(require_auth),
    ) -> dict[str, Any]:
        agent = app.state.runtime_registry.agent(request.agentId)
        if not agent:
            raise ManagementError("Agent was not found.", status_code=404)
        conversation = core_store.create_conversation(agent, title=request.title, metadata=request.metadata)
        return {"ok": True, "conversation": conversation}

    @app.get("/v1/conversations/{conversation_id}")
    async def core_conversation_detail(
        conversation_id: str,
        _auth: None = Depends(require_auth),
    ) -> dict[str, Any]:
        conversation = core_store.get_conversation(conversation_id)
        if not conversation:
            raise ManagementError("Conversation was not found.", status_code=404)
        return {"ok": True, "conversation": conversation}

    @app.get("/v1/conversations/{conversation_id}/messages")
    async def core_conversation_messages(
        conversation_id: str,
        _auth: None = Depends(require_auth),
    ) -> dict[str, Any]:
        conversation = core_store.get_conversation(conversation_id)
        if not conversation:
            raise ManagementError("Conversation was not found.", status_code=404)
        messages = coalesce_core_messages(core_store.list_messages(conversation_id))
        if messages:
            return {"ok": True, "conversationId": conversation_id, "messages": messages}
        external_session_id = conversation.get("externalSessionId") or ""
        if external_session_id:
            try:
                detail = store.conversation_detail(conversation["runtimeProfile"], external_session_id)
                return {
                    "ok": True,
                    "conversationId": conversation_id,
                    "messages": [
                        {**core_message_from_hermes(message), "conversationId": conversation_id}
                        for message in detail.messages
                    ],
                    "source": "hermes-management",
                    "warning": detail.warning,
                }
            except ManagementError as exc:
                return {"ok": True, "conversationId": conversation_id, "messages": [], "warning": exc.error}
        return {"ok": True, "conversationId": conversation_id, "messages": []}

    @app.post("/v1/conversations/{conversation_id}/messages")
    async def core_send_message(
        conversation_id: str,
        request: CoreMessageCreateRequest,
        http_request: Request,
        _auth: None = Depends(require_auth),
    ) -> dict[str, Any]:
        conversation = core_store.get_conversation(conversation_id)
        if not conversation:
            raise ManagementError("Conversation was not found.", status_code=404)
        agent = app.state.runtime_registry.agent(conversation["agentId"])
        if not agent:
            raise ManagementError("Agent was not found.", status_code=404)
        text = request.text.strip()
        if not text and not request.attachments:
            raise ManagementError("Message text is required.", status_code=400)
        message_id = request.clientMessageId or random_id("msg")
        idempotency_key = http_request.headers.get("Idempotency-Key") or request.clientMessageId
        user_event = core_store.append_event(
            conversation_id=conversation_id,
            agent_id=agent["id"],
            runtime_id=agent["runtimeId"],
            event_type="message.user.created",
            role="user",
            content=text,
            external_message_id=message_id,
            idempotency_key=idempotency_key,
            metadata={"attachments": request.attachments, "model": request.model, **request.metadata},
            event_id=f"evt_user_{message_id}",
        )
        core_store.upsert_message(
            conversation_id=conversation_id,
            message_id=message_id,
            role="user",
            content=text,
            status="completed",
            metadata={"attachments": request.attachments, "model": request.model, **request.metadata},
        )
        adapter = app.state.runtime_registry.adapter_for_runtime(agent["runtimeId"])
        chat_id = conversation["externalChatId"] or chat_id_for_conversation(conversation_id)
        if not conversation["externalChatId"]:
            core_store.update_conversation_link(conversation_id, external_chat_id=chat_id)
        runtime_metadata = {
            key: value
            for key, value in request.metadata.items()
            if key not in {"modelSwitch", "chatId"}
        }
        runtime_metadata.update({
            "agentuiConversationId": conversation_id,
            "chatId": chat_id,
            "profile": agent["runtimeProfile"],
        })
        switch_command = model_switch_command(request.metadata.get("modelSwitch"))
        if switch_command:
            switch_result = adapter.send_message(
                profile=agent["runtimeProfile"],
                chat_id=chat_id,
                chat_name=conversation["title"],
                message_id=f"{message_id}-model",
                text=switch_command,
                metadata={
                    **runtime_metadata,
                    "hidden": True,
                    "kind": "model-switch",
                    "replyTo": message_id,
                },
            )
            if not switch_result.get("ok"):
                core_store.append_event(
                    conversation_id=conversation_id,
                    agent_id=agent["id"],
                    runtime_id=agent["runtimeId"],
                    event_type="message.error",
                    role="assistant",
                    content=str(switch_result.get("error") or "Hermes gateway did not accept the model switch."),
                    parent_event_id=user_event["id"],
                    metadata={
                        "sendResult": switch_result,
                        "chatId": chat_id,
                        "profile": agent["runtimeProfile"],
                        "source": "agentui-core-send",
                    },
                )
                return {
                    "ok": False,
                    "conversationId": conversation_id,
                    "messageId": message_id,
                    "accepted": False,
                    "eventCursor": user_event["cursor"],
                    "error": switch_result.get("error") or "Hermes gateway did not accept the model switch.",
                }
        result = adapter.send_message(
            profile=agent["runtimeProfile"],
            chat_id=chat_id,
            chat_name=conversation["title"],
            message_id=message_id,
            text=text,
            metadata=runtime_metadata,
        )
        if not result.get("ok"):
            core_store.append_event(
                conversation_id=conversation_id,
                agent_id=agent["id"],
                runtime_id=agent["runtimeId"],
                event_type="message.error",
                role="assistant",
                content=str(result.get("error") or "Hermes gateway did not accept the message."),
                parent_event_id=user_event["id"],
                metadata={
                    "sendResult": result,
                    "chatId": chat_id,
                    "profile": agent["runtimeProfile"],
                    "source": "agentui-core-send",
                },
            )
            return {
                "ok": False,
                "conversationId": conversation_id,
                "messageId": message_id,
                "accepted": False,
                "eventCursor": user_event["cursor"],
                "error": result.get("error") or "Hermes gateway did not accept the message.",
            }
        core_store.update_conversation_link(conversation_id, external_chat_id=str(result.get("chatId") or chat_id))
        return {
            "ok": True,
            "conversationId": conversation_id,
            "messageId": message_id,
            "accepted": True,
            "eventCursor": user_event["cursor"],
            "runtime": result,
        }

    @app.post("/v1/conversations/{conversation_id}/cancel")
    async def core_cancel_message(conversation_id: str, _auth: None = Depends(require_auth)) -> dict[str, Any]:
        conversation = core_store.get_conversation(conversation_id)
        if not conversation:
            raise ManagementError("Conversation was not found.", status_code=404)
        agent = app.state.runtime_registry.agent(conversation["agentId"])
        if not agent:
            raise ManagementError("Agent was not found.", status_code=404)
        adapter = app.state.runtime_registry.adapter_for_runtime(agent["runtimeId"])
        result = adapter.send_message(
            profile=agent["runtimeProfile"],
            chat_id=conversation["externalChatId"] or chat_id_for_conversation(conversation_id),
            chat_name=conversation["title"],
            message_id=random_id("msg"),
            text="/stop",
            metadata={"kind": "cancel", "agentuiConversationId": conversation_id},
        )
        return {"ok": bool(result.get("ok")), "conversationId": conversation_id, "runtime": result}

    @app.get("/v1/events")
    async def core_events(
        after: int = Query(0),
        limit: int = Query(200),
        agentId: str | None = Query(None),
        _auth: None = Depends(require_auth),
    ) -> dict[str, Any]:
        if agentId and not app.state.runtime_registry.agent(agentId):
            raise ManagementError("Agent was not found.", status_code=404)
        after = clamp_int(after, default=0, minimum=0, maximum=9_223_372_036_854_775_807)
        limit = clamp_int(limit, default=200, minimum=1, maximum=500)
        events = core_store.list_events(after=after, limit=limit, agent_id=agentId)
        return {
            "ok": True,
            "events": events,
            "cursor": events[-1]["cursor"] if events else core_store.latest_event_cursor(agent_id=agentId),
        }

    @app.get("/v1/conversations/{conversation_id}/events")
    async def core_conversation_events(
        conversation_id: str,
        after: int = Query(0),
        limit: int = Query(200),
        _auth: None = Depends(require_auth),
    ) -> dict[str, Any]:
        if not core_store.get_conversation(conversation_id):
            raise ManagementError("Conversation was not found.", status_code=404)
        after = clamp_int(after, default=0, minimum=0, maximum=9_223_372_036_854_775_807)
        limit = clamp_int(limit, default=200, minimum=1, maximum=500)
        events = core_store.list_events(after=after, limit=limit, conversation_id=conversation_id)
        return {
            "ok": True,
            "events": events,
            "cursor": events[-1]["cursor"] if events else core_store.latest_event_cursor(conversation_id),
        }

    @app.get("/v1/events/stream")
    async def core_event_stream(
        request: Request,
        after: int = Query(0),
        limit: int = Query(200),
        agentId: str | None = Query(None),
        live: bool = Query(True),
        _auth: None = Depends(require_auth),
    ) -> StreamingResponse:
        if agentId and not app.state.runtime_registry.agent(agentId):
            raise ManagementError("Agent was not found.", status_code=404)
        after = clamp_int(after, default=0, minimum=0, maximum=9_223_372_036_854_775_807)
        limit = clamp_int(limit, default=200, minimum=1, maximum=500)

        async def event_generator():
            cursor = after
            heartbeat_at = now()
            while True:
                events = core_store.list_events(after=cursor, limit=limit, agent_id=agentId)
                for event in events:
                    cursor = max(cursor, int(event["cursor"]))
                    yield sse_event(event)
                if not live:
                    break
                if await request.is_disconnected():
                    break
                if not events and now() - heartbeat_at >= 15:
                    heartbeat_at = now()
                    yield ": keep-alive\n\n"
                await asyncio.sleep(0.5)

        return StreamingResponse(
            event_generator(),
            media_type="text/event-stream",
            headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
        )

    @app.post("/v1/runtime-deliveries/hermes")
    async def runtime_delivery_hermes(
        delivery: RuntimeDeliveryHermesRequest,
        _auth: None = Depends(require_runtime_delivery_auth),
    ) -> dict[str, Any]:
        conversation_id = core_store.resolve_conversation_id(delivery.runtimeId, delivery.profile, "", delivery.chatId)
        if not conversation_id:
            app.state.runtime_registry.ensure_default_runtime()
            agent = core_store.agent_for_profile(delivery.runtimeId, delivery.profile)
            if not agent:
                raise ManagementError("Delivery profile is not mapped to an Iris agent.", status_code=404)
            conversation = core_store.create_conversation(
                agent,
                title=f"{delivery.profile} delivery",
                external_chat_id=delivery.chatId,
                metadata={"createdBy": "runtime-delivery"},
            )
            conversation_id = conversation["id"]
        conversation = core_store.get_conversation(conversation_id)
        if not conversation:
            raise ManagementError("Delivery conversation was not found.", status_code=404)
        agent = app.state.runtime_registry.agent(conversation["agentId"])
        if not agent:
            raise ManagementError("Delivery agent was not found.", status_code=404)
        stream_message_id = str(
            delivery.metadata.get("streamMessageId")
            or delivery.metadata.get("stream_message_id")
            or delivery.messageId
        )
        is_streaming = bool(delivery.metadata.get("streaming"))
        is_final = bool(delivery.metadata.get("finalize") or delivery.metadata.get("final"))
        event_type = "message.assistant.completed" if is_final or not is_streaming else "message.assistant.delta"
        event_metadata = {
            "profile": delivery.profile,
            "chatId": delivery.chatId,
            "source": delivery.source,
            **delivery.metadata,
        }
        if has_stream_message_id(delivery.metadata):
            event_metadata["streamMessageId"] = stream_message_id
        event = core_store.append_event(
            conversation_id=conversation_id,
            agent_id=agent["id"],
            runtime_id=delivery.runtimeId,
            event_type=event_type,
            role="assistant",
            content=delivery.content,
            parent_event_id=delivery.replyTo,
            external_message_id=delivery.messageId,
            metadata=event_metadata,
            event_id=f"evt_delivery_{delivery.messageId}",
        )
        materialized = materialize_runtime_delivery(
            core_store=core_store,
            conversation_id=conversation_id,
            delivery=delivery,
            stream_message_id=stream_message_id,
            is_streaming=is_streaming,
            is_final=is_final,
        )
        if materialized and event.get("metadata") is not None:
            event["metadata"]["materializedMessageId"] = materialized["id"]
        return {"ok": True, "conversationId": conversation_id, "event": event}

    @app.get("/v1/automations")
    async def core_automations(
        agentId: str | None = Query(None),
        limit: int = Query(200),
        _auth: None = Depends(require_auth),
    ) -> dict[str, Any]:
        if agentId and not app.state.runtime_registry.agent(agentId):
            raise ManagementError("Agent was not found.", status_code=404)
        sync_core_automations(app, agentId)
        return {
            "ok": True,
            "automations": core_store.list_automations(agent_id=agentId, limit=limit),
        }

    @app.post("/v1/automations")
    async def core_create_automation(
        request: CoreAutomationCreateRequest,
        _auth: None = Depends(require_auth),
    ) -> dict[str, Any]:
        agent = app.state.runtime_registry.agent(request.agentId)
        if not agent:
            raise ManagementError("Agent was not found.", status_code=404)
        payload = automation_create_payload(core_store, agent, dump_model(request))
        adapter = app.state.runtime_registry.adapter_for_runtime(agent["runtimeId"])
        result = adapter.create_automation(payload)
        if not result.get("ok"):
            return {
                "ok": False,
                "error": result.get("error") or "Could not create Hermes job.",
                "runtime": result,
            }
        job = automation_job_payload(result)
        automation = core_store.upsert_automation(
            automation_record_from_request(
                agent,
                dump_model(request),
                external_job_id=job_id(job),
                status=job_status(job) or "active",
                runtime_job=job,
                deliver=payload.get("deliver", ""),
                last_run_at=job_timestamp(job, "lastRunAt", "last_run_at", "lastRun", "last_run"),
                next_run_at=job_timestamp(job, "nextRunAt", "next_run_at", "nextRun", "next_run"),
            )
        )
        return {"ok": True, "automation": automation, "runtime": result}

    @app.patch("/v1/automations/{automation_id}")
    async def core_update_automation(
        automation_id: str,
        request: CoreAutomationUpdateRequest,
        _auth: None = Depends(require_auth),
    ) -> dict[str, Any]:
        automation = core_store.get_automation(automation_id)
        if not automation:
            raise ManagementError("Automation was not found.", status_code=404)
        agent = app.state.runtime_registry.agent(automation["agentId"])
        if not agent:
            raise ManagementError("Automation agent was not found.", status_code=404)
        updates = {key: value for key, value in dump_model(request).items() if value not in (None, "", {})}
        result: dict[str, Any] = {"ok": True}
        if automation["externalJobId"]:
            adapter = app.state.runtime_registry.adapter_for_runtime(automation["runtimeId"])
            result = adapter.update_automation(automation["externalJobId"], automation_update_payload(updates))
            if not result.get("ok"):
                return {"ok": False, "error": result.get("error") or "Could not update Hermes job.", "runtime": result}
        record_updates = automation_store_updates(core_store, agent, automation, updates)
        updated = core_store.update_automation(automation_id, record_updates)
        return {"ok": True, "automation": updated, "runtime": result}

    @app.delete("/v1/automations/{automation_id}")
    async def core_delete_automation(automation_id: str, _auth: None = Depends(require_auth)) -> dict[str, Any]:
        automation = core_store.get_automation(automation_id)
        if not automation:
            raise ManagementError("Automation was not found.", status_code=404)
        result: dict[str, Any] = {"ok": True}
        if automation["externalJobId"]:
            adapter = app.state.runtime_registry.adapter_for_runtime(automation["runtimeId"])
            result = adapter.delete_automation(automation["externalJobId"])
            if not result.get("ok") and "not found" not in str(result.get("error") or "").lower():
                return {"ok": False, "error": result.get("error") or "Could not delete Hermes job.", "runtime": result}
        core_store.delete_automation(automation_id)
        return {"ok": True, "automationId": automation_id, "runtime": result}

    @app.post("/v1/automations/{automation_id}/pause")
    async def core_pause_automation(automation_id: str, _auth: None = Depends(require_auth)) -> dict[str, Any]:
        return control_core_automation(app, automation_id, "pause", "paused")

    @app.post("/v1/automations/{automation_id}/resume")
    async def core_resume_automation(automation_id: str, _auth: None = Depends(require_auth)) -> dict[str, Any]:
        return control_core_automation(app, automation_id, "resume", "active")

    @app.post("/v1/automations/{automation_id}/run")
    async def core_run_automation(automation_id: str, _auth: None = Depends(require_auth)) -> dict[str, Any]:
        return control_core_automation(app, automation_id, "run", None)

    @app.get("/v1/agents/{agent_id}/models")
    async def core_agent_models(agent_id: str, _auth: None = Depends(require_auth)) -> dict[str, Any]:
        agent = app.state.runtime_registry.agent(agent_id)
        if not agent:
            raise ManagementError("Agent was not found.", status_code=404)
        adapter = app.state.runtime_registry.adapter_for_runtime(agent["runtimeId"])
        return adapter.models(agent["runtimeProfile"])

    @app.get("/v1/agents/{agent_id}/slash-commands")
    async def core_agent_slash_commands(agent_id: str, _auth: None = Depends(require_auth)) -> dict[str, Any]:
        agent = app.state.runtime_registry.agent(agent_id)
        if not agent:
            raise ManagementError("Agent was not found.", status_code=404)
        adapter = app.state.runtime_registry.adapter_for_runtime(agent["runtimeId"])
        return adapter.slash_commands(agent["runtimeProfile"])

    @app.post("/v1/agents/{agent_id}/slash-complete")
    async def core_agent_slash_complete(
        agent_id: str,
        request: Request,
        _auth: None = Depends(require_auth),
    ) -> dict[str, Any]:
        agent = app.state.runtime_registry.agent(agent_id)
        if not agent:
            raise ManagementError("Agent was not found.", status_code=404)
        body = await request.json()
        adapter = app.state.runtime_registry.adapter_for_runtime(agent["runtimeId"])
        return adapter.slash_complete(agent["runtimeProfile"], text=str(body.get("text") or ""), limit=int(body.get("limit") or 30))

    @app.get("/v1/profiles", response_model=ProfilesResponse)
    async def profiles(_auth: None = Depends(require_auth)) -> ProfilesResponse:
        return ProfilesResponse(
            hermesHome=str(store.root),
            activeProfile=store.active_profile_name(),
            profiles=store.profiles(),
        )

    @app.get("/v1/profiles/{profile}", response_model=ProfileResponse)
    async def profile(profile: str, _auth: None = Depends(require_auth)) -> ProfileResponse:
        summary = store.profile_summary(profile)
        return ProfileResponse(ok=True, **dump_model(summary))

    @app.post("/v1/profiles", response_model=ProfileActionResponse)
    async def create_profile(
        request: ProfileCreateRequest,
        _auth: None = Depends(require_auth),
    ) -> ProfileActionResponse:
        summary = store.create_profile(request.name)
        return ProfileActionResponse(profile=summary.name, profiles=store.profiles())

    @app.post("/v1/profiles/{profile}/clone", response_model=ProfileActionResponse)
    async def clone_profile(
        profile: str,
        request: ProfileCloneRequest,
        _auth: None = Depends(require_auth),
    ) -> ProfileActionResponse:
        summary = store.clone_profile(profile, request.name)
        return ProfileActionResponse(profile=summary.name, profiles=store.profiles())

    @app.delete("/v1/profiles/{profile}", response_model=ProfileActionResponse)
    async def delete_profile(profile: str, _auth: None = Depends(require_auth)) -> ProfileActionResponse:
        next_profile = store.delete_profile(profile)
        return ProfileActionResponse(profile=next_profile, profiles=store.profiles())

    @app.get("/v1/profiles/{profile}/memory", response_model=MemoryResponse)
    async def memory(profile: str, _auth: None = Depends(require_auth)) -> MemoryResponse:
        memory_file, user_file = store.memory_files(profile)
        directory = store.profile_directory(profile)
        return MemoryResponse(
            profile=profile,
            path=str(directory / "memories"),
            files=[memory_file, user_file],
            memory=memory_file,
            user=user_file,
        )

    @app.get(
        "/v1/profiles/{profile}/conversations",
        response_model=ConversationsResponse,
    )
    async def conversations(
        profile: str,
        limit: int = Query(80),
        _auth: None = Depends(require_auth),
    ) -> ConversationsResponse:
        result = store.conversations(profile, limit)
        return ConversationsResponse(
            profile=profile,
            path=result.path,
            schemaVersion=result.schema_version,
            conversations=result.conversations,
            warning=result.warning,
        )

    @app.get(
        "/v1/profiles/{profile}/conversations/{conversation_id}",
        response_model=ConversationDetailResponse,
    )
    async def conversation_detail(
        profile: str,
        conversation_id: str,
        _auth: None = Depends(require_auth),
    ) -> ConversationDetailResponse:
        result = store.conversation_detail(profile, conversation_id)
        return ConversationDetailResponse(
            profile=profile,
            path=result.path,
            schemaVersion=result.schema_version,
            conversation=result.conversation,
            messages=result.messages,
            warning=result.warning,
        )

    @app.get("/v1/profiles/{profile}/skills", response_model=SkillsResponse)
    async def skills(profile: str, _auth: None = Depends(require_auth)) -> SkillsResponse:
        directory = store.profile_directory(profile)
        return SkillsResponse(profile=profile, path=str(directory / "skills"), skills=store.skills(profile))

    @app.get("/v1/profiles/{profile}/skills/{skill_id}", response_model=SkillDetailResponse)
    async def skill_detail(
        profile: str,
        skill_id: str,
        _auth: None = Depends(require_auth),
    ) -> SkillDetailResponse:
        summary, content = store.skill_detail(profile, skill_id)
        return SkillDetailResponse(ok=True, profile=profile, content=content, **dump_model(summary))

    return app


def core_status_payload(*, request_app: FastAPI) -> dict[str, Any]:
    core_store: CoreStore = request_app.state.core_store
    runtimes = request_app.state.runtime_registry.runtimes()
    agents = request_app.state.runtime_registry.agents()
    return {
        **core_store.health(),
        "runtimeCount": len(runtimes),
        "agentCount": len(agents),
        **core_auth_payload(request_app),
    }


def core_auth_payload(request_app: FastAPI) -> dict[str, Any]:
    settings: Settings = request_app.state.settings
    devices = request_app.state.core_store.list_devices()
    active_devices = [device for device in devices if device.get("revokedAt") is None]
    remote_auth_required = not host_is_loopback(settings.host)
    return {
        "authMode": "bearer" if request_app.state.management_token or remote_auth_required else "none",
        "remoteAuthRequired": remote_auth_required,
        "deviceCount": len(devices),
        "activeDeviceCount": len(active_devices),
    }


def sync_core_conversations(app: FastAPI, agent_id: str | None, limit: int) -> None:
    registry: RuntimeRegistry = app.state.runtime_registry
    core_store: CoreStore = app.state.core_store
    hermes_store: HermesStore = app.state.store
    agents = [registry.agent(agent_id)] if agent_id else registry.agents()
    for agent in [row for row in agents if row]:
        if agent["runtimeKind"] != "hermes":
            continue
        try:
            result = hermes_store.conversations(agent["runtimeProfile"], limit)
        except ManagementError:
            continue
        for conversation in result.conversations:
            core_store.upsert_runtime_conversation(agent, conversation)


def sync_core_automations(app: FastAPI, agent_id: str | None) -> None:
    registry: RuntimeRegistry = app.state.runtime_registry
    core_store: CoreStore = app.state.core_store
    agents = [registry.agent(agent_id)] if agent_id else registry.agents()
    for agent in [row for row in agents if row]:
        if agent["runtimeKind"] != "hermes":
            continue
        adapter = registry.adapter_for_runtime(agent["runtimeId"])
        result = adapter.list_automations(agent["runtimeProfile"])
        if not result.get("ok"):
            continue
        for job in automation_jobs_from_result(result):
            external_job_id = job_id(job)
            if not external_job_id:
                continue
            core_store.upsert_automation(
                {
                    "agentId": agent["id"],
                    "runtimeId": agent["runtimeId"],
                    "externalJobId": external_job_id,
                    "name": str(job.get("name") or "Hermes job"),
                    "schedule": job_schedule(job),
                    "prompt": str(job.get("prompt") or ""),
                    "deliverToConversationId": "",
                    "status": job_status(job) or "active",
                    "lastRunAt": job_timestamp(job, "lastRunAt", "last_run_at", "lastRun", "last_run"),
                    "nextRunAt": job_timestamp(job, "nextRunAt", "next_run_at", "nextRun", "next_run"),
                    "metadata": {
                        "source": "hermes-jobs",
                        "deliver": str(job.get("deliver") or job.get("delivery") or ""),
                        "repeat": job_repeat(job),
                        "runtimeJob": job,
                    },
                }
            )


def mirror_inbox_message_to_core(app: FastAPI, message: dict[str, Any]) -> None:
    core_store: CoreStore = app.state.core_store
    runtime_id = str(message.get("metadata", {}).get("runtimeId") or DEFAULT_RUNTIME_ID)
    profile = str(message.get("profile") or "default")
    chat_id = str(message.get("chatId") or "agentui")
    conversation_id = core_store.resolve_conversation_id(runtime_id, profile, "", chat_id)
    if not conversation_id:
        app.state.runtime_registry.ensure_default_runtime()
        agent = core_store.agent_for_profile(runtime_id, profile)
        if not agent:
            return
        conversation = core_store.create_conversation(
            agent,
            title=f"{profile} delivery",
            external_chat_id=chat_id,
            metadata={"createdBy": "legacy-inbox-delivery"},
        )
        conversation_id = conversation["id"]
    conversation = core_store.get_conversation(conversation_id)
    if not conversation:
        return
    agent = app.state.runtime_registry.agent(conversation["agentId"])
    if not agent:
        return
    metadata = message.get("metadata") if isinstance(message.get("metadata"), dict) else {}
    stream_message_id = str(metadata.get("streamMessageId") or metadata.get("stream_message_id") or "")
    is_streaming = bool(metadata.get("streaming"))
    is_final = bool(metadata.get("finalize") or metadata.get("final"))
    event_type = "message.assistant.completed" if is_final or not is_streaming else "message.assistant.delta"
    event_metadata = {
        "profile": profile,
        "chatId": chat_id,
        "source": str(message.get("source") or "legacy-inbox"),
        "platform": str(message.get("platform") or "agentui"),
        **metadata,
    }
    if stream_message_id:
        event_metadata["streamMessageId"] = stream_message_id
    event = core_store.append_event(
        conversation_id=conversation_id,
        agent_id=agent["id"],
        runtime_id=runtime_id,
        event_type=event_type,
        role="assistant",
        content=str(message.get("content") or ""),
        parent_event_id=str(metadata.get("replyTo") or ""),
        external_message_id=str(message.get("id") or ""),
        metadata=event_metadata,
        event_id=f"evt_inbox_{message.get('id')}",
    )
    message_id = stream_message_id or str(message.get("id") or random_id("msg"))
    content = str(message.get("content") or "")
    status = "completed" if is_final or not is_streaming else "streaming"
    messages = core_store.list_messages(conversation_id)
    if stream_message_id:
        existing = message_by_id(messages, stream_message_id)
        if existing and existing["status"] == "completed" and status == "streaming":
            materialized = existing
        else:
            materialized = core_store.upsert_message(
                conversation_id=conversation_id,
                message_id=message_id,
                role="assistant",
                content=content,
                status=status,
                metadata=event_metadata,
            )
    else:
        existing = last_mergeable_assistant_message(
            messages,
            reply_to=str(metadata.get("replyTo") or ""),
            content=content,
        )
        if existing:
            message_id = existing["id"]
            content = append_message_content(existing["content"], content)
            event_metadata = {**existing.get("metadata", {}), **event_metadata}
        materialized = core_store.upsert_message(
            conversation_id=conversation_id,
            message_id=message_id,
            role="assistant",
            content=content,
            status=status,
            metadata=event_metadata,
        )
    if materialized and event.get("metadata") is not None:
        event["metadata"]["materializedMessageId"] = materialized["id"]


def automation_create_payload(core_store: CoreStore, agent: dict[str, Any], request: dict[str, Any]) -> dict[str, Any]:
    schedule = str(request.get("schedule") or "").strip()
    prompt = str(request.get("prompt") or "").strip()
    if not schedule:
        raise ManagementError("Automation schedule is required.", status_code=400)
    if not prompt:
        raise ManagementError("Automation prompt is required.", status_code=400)
    deliver = str(request.get("deliver") or "").strip()
    conversation_id = str(request.get("deliverToConversationId") or "").strip()
    if conversation_id:
        conversation = core_store.get_conversation(conversation_id)
        if not conversation or conversation["agentId"] != agent["id"]:
            raise ManagementError("Delivery conversation was not found for this agent.", status_code=404)
        deliver = deliver or f"agentui:{conversation['externalChatId'] or chat_id_for_conversation(conversation_id)}"
    payload: dict[str, Any] = {
        "name": str(request.get("name") or "Iris reminder"),
        "schedule": schedule,
        "prompt": prompt,
    }
    if deliver:
        payload["deliver"] = deliver
    repeat = request.get("repeat")
    if repeat not in (None, ""):
        payload["repeat"] = max(1, int(repeat))
    return payload


def automation_record_from_request(
    agent: dict[str, Any],
    request: dict[str, Any],
    *,
    external_job_id: str,
    status: str,
    runtime_job: dict[str, Any],
    deliver: str,
    last_run_at: int | None = None,
    next_run_at: int | None = None,
) -> dict[str, Any]:
    metadata = request.get("metadata") if isinstance(request.get("metadata"), dict) else {}
    return {
        "agentId": agent["id"],
        "runtimeId": agent["runtimeId"],
        "externalJobId": external_job_id,
        "name": str(request.get("name") or "Iris reminder"),
        "schedule": str(request.get("schedule") or ""),
        "prompt": str(request.get("prompt") or ""),
        "deliverToConversationId": str(request.get("deliverToConversationId") or ""),
        "status": status,
        "lastRunAt": last_run_at,
        "nextRunAt": next_run_at,
        "metadata": {
            **metadata,
            "source": "agentui-core",
            "deliver": deliver,
            "repeat": request.get("repeat"),
            "runtimeJob": runtime_job,
        },
    }


def automation_update_payload(updates: dict[str, Any]) -> dict[str, Any]:
    payload: dict[str, Any] = {}
    for request_key, runtime_key in (
        ("name", "name"),
        ("schedule", "schedule"),
        ("prompt", "prompt"),
        ("deliver", "deliver"),
        ("repeat", "repeat"),
    ):
        value = updates.get(request_key)
        if value not in (None, ""):
            payload[runtime_key] = value
    return payload


def automation_store_updates(
    core_store: CoreStore,
    agent: dict[str, Any],
    automation: dict[str, Any],
    updates: dict[str, Any],
) -> dict[str, Any]:
    deliver = str(updates.get("deliver") or automation.get("metadata", {}).get("deliver") or "")
    conversation_id = str(updates.get("deliverToConversationId") or automation.get("deliverToConversationId") or "")
    if conversation_id:
        conversation = core_store.get_conversation(conversation_id)
        if not conversation or conversation["agentId"] != agent["id"]:
            raise ManagementError("Delivery conversation was not found for this agent.", status_code=404)
        deliver = deliver or f"agentui:{conversation['externalChatId'] or chat_id_for_conversation(conversation_id)}"
    metadata = updates.get("metadata") if isinstance(updates.get("metadata"), dict) else {}
    return {
        "name": updates.get("name") or automation["name"],
        "schedule": updates.get("schedule") or automation["schedule"],
        "prompt": updates.get("prompt") or automation["prompt"],
        "deliverToConversationId": conversation_id,
        "status": updates.get("status") or automation["status"],
        "metadata": {
            **metadata,
            "deliver": deliver,
            "repeat": updates.get("repeat", automation.get("metadata", {}).get("repeat")),
        },
    }


def control_core_automation(app: FastAPI, automation_id: str, action: str, status: str | None) -> dict[str, Any]:
    core_store: CoreStore = app.state.core_store
    automation = core_store.get_automation(automation_id)
    if not automation:
        raise ManagementError("Automation was not found.", status_code=404)
    if not automation["externalJobId"]:
        raise ManagementError("Automation is not linked to a Hermes job.", status_code=400)
    adapter = app.state.runtime_registry.adapter_for_runtime(automation["runtimeId"])
    result = adapter.control_automation(automation["externalJobId"], action)
    if not result.get("ok"):
        return {"ok": False, "error": result.get("error") or f"Could not {action} Hermes job.", "runtime": result}
    updates: dict[str, Any] = {}
    if status:
        updates["status"] = status
    if action == "run":
        updates["lastRunAt"] = now()
    updated = core_store.update_automation(automation_id, updates) if updates else automation
    return {"ok": True, "automation": updated, "runtime": result}


def automation_jobs_from_result(result: dict[str, Any]) -> list[dict[str, Any]]:
    raw_jobs = (
        result.get("jobs")
        if isinstance(result.get("jobs"), list)
        else result.get("items")
        if isinstance(result.get("items"), list)
        else result.get("data")
        if isinstance(result.get("data"), list)
        else []
    )
    return [row for row in raw_jobs if isinstance(row, dict)]


def automation_job_payload(result: dict[str, Any]) -> dict[str, Any]:
    for key in ("job", "automation", "item", "data"):
        value = result.get(key)
        if isinstance(value, dict):
            return value
    return result


def job_id(job: dict[str, Any]) -> str:
    return str(job.get("id") or job.get("jobId") or job.get("job_id") or "")


def job_schedule(job: dict[str, Any]) -> str:
    schedule = job.get("schedule") if isinstance(job.get("schedule"), dict) else {}
    return str(job.get("schedule_display") or schedule.get("display") or job.get("schedule") or job.get("cron") or job.get("when") or "")


def job_repeat(job: dict[str, Any]) -> int | None:
    repeat = job.get("repeat") if isinstance(job.get("repeat"), dict) else {}
    value = repeat.get("times") if isinstance(repeat, dict) else None
    value = value if value not in (None, "") else job.get("repeat")
    try:
        return int(value) if value not in (None, "") else None
    except (TypeError, ValueError):
        return None


def job_status(job: dict[str, Any]) -> str:
    raw = str(job.get("status") or job.get("state") or ("paused" if job.get("enabled") is False else "active")).lower()
    if "pause" in raw:
        return "paused"
    if "complete" in raw or "done" in raw:
        return "completed"
    if "error" in raw or "fail" in raw:
        return "error"
    if any(word in raw for word in ("active", "run", "enabled", "scheduled", "pending")):
        return "active"
    return "unknown"


def job_timestamp(job: dict[str, Any], *keys: str) -> int | None:
    schedule = job.get("schedule") if isinstance(job.get("schedule"), dict) else {}
    candidates: list[Any] = [job.get(key) for key in keys]
    if "next_run_at" in keys:
        candidates.append(schedule.get("run_at"))
    for value in candidates:
        if value in (None, ""):
            continue
        try:
            return int(float(value))
        except (TypeError, ValueError):
            pass
        if isinstance(value, str):
            try:
                from datetime import datetime

                parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
                return int(parsed.timestamp())
            except ValueError:
                continue
    return None


def json_dumps(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def sse_event(event: dict[str, Any]) -> str:
    return (
        f"event: {event['type']}\n"
        f"id: {event['cursor']}\n"
        f"data: {json_dumps(event)}\n\n"
    )


def materialize_runtime_delivery(
    *,
    core_store: CoreStore,
    conversation_id: str,
    delivery: RuntimeDeliveryHermesRequest,
    stream_message_id: str,
    is_streaming: bool,
    is_final: bool,
) -> dict[str, Any]:
    status = "completed" if is_final or not is_streaming else "streaming"
    metadata = {
        "profile": delivery.profile,
        "chatId": delivery.chatId,
        "replyTo": delivery.replyTo,
        "source": delivery.source,
        **delivery.metadata,
    }
    if has_stream_message_id(delivery.metadata):
        metadata["streamMessageId"] = stream_message_id
    target_id = stream_message_id if stream_message_id else delivery.messageId
    content = delivery.content
    messages = core_store.list_messages(conversation_id)

    if has_stream_message_id(delivery.metadata):
        existing = message_by_id(messages, target_id)
        if existing and existing["status"] == "completed" and status == "streaming":
            return existing

    if not has_stream_message_id(delivery.metadata):
        existing = last_mergeable_assistant_message(
            messages,
            reply_to=delivery.replyTo or "",
            content=delivery.content,
        )
        if existing:
            target_id = existing["id"]
            content = append_message_content(existing["content"], delivery.content)
            metadata = {**existing.get("metadata", {}), **metadata}

    return core_store.upsert_message(
        conversation_id=conversation_id,
        message_id=target_id,
        role="assistant",
        content=content,
        status=status,
        metadata=metadata,
    )


def has_stream_message_id(metadata: dict[str, Any]) -> bool:
    return bool(metadata.get("streamMessageId") or metadata.get("stream_message_id"))


def message_by_id(messages: list[dict[str, Any]], message_id: str) -> dict[str, Any] | None:
    for message in messages:
        if message["id"] == message_id:
            return message
    return None


def coalesce_core_messages(messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
    coalesced: list[dict[str, Any]] = []
    for message in messages:
        if message["role"] == "assistant" and coalesced:
            previous = coalesced[-1]
            if (
                previous["role"] == "assistant"
                and normalize_message_content(str(previous.get("content") or ""))
                == normalize_message_content(str(message.get("content") or ""))
                and is_gateway_replay_pair(previous, message)
            ):
                if message.get("status") == "completed" and previous.get("status") != "completed":
                    coalesced[-1] = {
                        **previous,
                        "status": "completed",
                        "updatedAt": message.get("updatedAt") or previous.get("updatedAt"),
                    }
                continue
        coalesced.append(message)
    return coalesced


def is_gateway_replay_pair(left: dict[str, Any], right: dict[str, Any]) -> bool:
    left_metadata = left.get("metadata") if isinstance(left.get("metadata"), dict) else {}
    right_metadata = right.get("metadata") if isinstance(right.get("metadata"), dict) else {}
    left_source = str(left_metadata.get("source") or "")
    right_source = str(right_metadata.get("source") or "")
    if not left_source.startswith("hermes-gateway") or not right_source.startswith("hermes-gateway"):
        return False
    return bool(
        left_metadata.get("streamMessageId")
        or right_metadata.get("streamMessageId")
        or (
            left_metadata.get("replyTo")
            and left_metadata.get("replyTo") == right_metadata.get("replyTo")
        )
    )


def last_mergeable_assistant_message(
    messages: list[dict[str, Any]],
    *,
    reply_to: str,
    content: str,
) -> dict[str, Any] | None:
    normalized_content = normalize_message_content(content)
    for message in reversed(messages):
        if message["role"] == "user":
            break
        if message["role"] != "assistant":
            continue
        metadata = message.get("metadata") if isinstance(message.get("metadata"), dict) else {}
        if message["status"] == "streaming":
            return message
        if (
            normalized_content
            and normalize_message_content(str(message.get("content") or "")) == normalized_content
            and (metadata.get("streamMessageId") or (reply_to and metadata.get("replyTo") == reply_to))
        ):
            return message
        if is_post_stream_attachment(content) and (metadata.get("streamMessageId") or metadata.get("replyTo") == reply_to):
            return message
    return None


def normalize_message_content(content: str) -> str:
    return "\n".join(line.rstrip() for line in content.strip().splitlines())


def is_post_stream_attachment(content: str) -> bool:
    stripped = content.strip()
    return bool(
        stripped.startswith("Media:")
        or stripped.startswith("Image:")
        or stripped.startswith("File:")
        or stripped.startswith("🖼️ Image:")
        or stripped.startswith("📎 File:")
    )


def append_message_content(content: str, addition: str) -> str:
    left = content.rstrip()
    right = addition.strip()
    if not left:
        return right
    if not right or right in left:
        return left
    return f"{left}\n\n{right}"


def dump_model(model):
    if hasattr(model, "model_dump"):
        return model.model_dump()
    return model.dict()


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Run the Hermes management sidecar server.")
    parser.add_argument("--host", default=None, help="Bind host. Defaults to HERMES_MGMT_HOST or 127.0.0.1.")
    parser.add_argument("--port", type=int, default=None, help="Bind port. Defaults to HERMES_MGMT_PORT or 8765.")
    parser.add_argument("--hermes-home", default=None, help="Hermes home path. Defaults to HERMES_HOME or ~/.hermes.")
    return parser


def settings_from_args(args: argparse.Namespace) -> Settings:
    env_settings = Settings.from_env()
    hermes_home = args.hermes_home or env_settings.hermes_home
    host = args.host or env_settings.host
    port = args.port if args.port is not None else env_settings.port
    if port < 1 or port > 65535:
        raise SystemExit(f"Port must be between 1 and 65535: {port}")
    return Settings(
        hermes_home=str(normalize_hermes_home(hermes_home)),
        host=host,
        port=port,
        token=env_settings.token,
        inbox_token=env_settings.inbox_token,
        runtime_delivery_token=env_settings.runtime_delivery_token,
        inbox_store_path=env_settings.inbox_store_path,
        core_store_path=env_settings.core_store_path,
        cors_origins=env_settings.cors_origins,
    )


def cli() -> None:
    parser = build_parser()
    args = parser.parse_args()
    settings = settings_from_args(args)
    uvicorn.run(create_app(settings), host=settings.host, port=settings.port)


app = create_app()


if __name__ == "__main__":
    cli()
