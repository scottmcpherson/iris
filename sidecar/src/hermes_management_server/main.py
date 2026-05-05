"""FastAPI application and CLI entrypoint."""

from __future__ import annotations

import argparse
import os
from dataclasses import dataclass

import uvicorn
from fastapi import Depends, FastAPI, Query
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

from .hermes_store import HermesStore, checked_at, normalize_hermes_home
from .models import (
    ConversationDetailResponse,
    ConversationsResponse,
    ErrorResponse,
    HealthResponse,
    ProfileActionResponse,
    ProfileCloneRequest,
    ProfileCreateRequest,
    MemoryResponse,
    ProfileResponse,
    ProfilesResponse,
    SkillDetailResponse,
    SkillsResponse,
    StatusResponse,
)
from .security import ManagementError, make_auth_dependency


@dataclass(frozen=True)
class Settings:
    hermes_home: str | None = None
    host: str = "127.0.0.1"
    port: int = 8765
    token: str | None = None
    cors_origins: tuple[str, ...] = ()

    @classmethod
    def from_env(cls) -> "Settings":
        return cls(
            hermes_home=os.environ.get("HERMES_HOME") or None,
            host=os.environ.get("HERMES_MGMT_HOST") or "127.0.0.1",
            port=parse_port(os.environ.get("HERMES_MGMT_PORT"), 8765),
            token=os.environ.get("HERMES_MGMT_TOKEN") or None,
            cors_origins=parse_cors_origins(os.environ.get("HERMES_MGMT_CORS_ORIGINS")),
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


def create_app(settings: Settings | None = None) -> FastAPI:
    app_settings = settings or Settings.from_env()
    store = HermesStore(app_settings.hermes_home)
    app = FastAPI(
        title="Hermes Management Server",
        version="0.1.0",
        docs_url=None,
        redoc_url=None,
        default_response_class=JSONResponse,
        responses={400: {"model": ErrorResponse}, 401: {"model": ErrorResponse}, 404: {"model": ErrorResponse}},
    )
    app.state.store = store
    app.state.settings = app_settings
    app.state.management_token = app_settings.token or ""

    if app_settings.cors_origins:
        app.add_middleware(
            CORSMiddleware,
            allow_origins=list(app_settings.cors_origins),
            allow_credentials=True,
            allow_methods=["GET", "POST", "DELETE"],
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

    @app.get("/health", response_model=HealthResponse)
    async def health(_auth: None = Depends(require_auth)) -> HealthResponse:
        return HealthResponse(
            checkedAt=checked_at(),
            hermesHome=str(store.root),
            profilesRootExists=store.profiles_root.is_dir(),
        )

    @app.get("/v1/status", response_model=StatusResponse)
    async def status(_auth: None = Depends(require_auth)) -> StatusResponse:
        profiles = store.profiles()
        return StatusResponse(
            checkedAt=checked_at(),
            hermesHome=str(store.root),
            activeProfile=store.active_profile_name(),
            profileCount=len(profiles),
        )

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
