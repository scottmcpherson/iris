"""Hermes runtime adapter for Iris Core."""

from __future__ import annotations

import json
import ipaddress
import os
import shutil
import sqlite3
import subprocess
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from pathlib import Path
from typing import Any

from ..attachment_types import normalized_runtime_mime_type
from ..core_store import (
    DEFAULT_RUNTIME_ID,
    CoreStore,
    agent_from_profile_summary,
    session_from_runtime_summary,
    core_message_from_hermes,
    message_content_hash_candidates,
    normalize_assistant_content,
)
from .hermes_store import (
    HermesStore,
    distribution_manifest,
    inspect_archive_root,
    memory_file_name,
    normalize_profile_name,
    normalize_hermes_home,
    normalized_memory_file_key,
    stage_distribution_source,
    validate_profile_name,
)
from ..security import ManagementError


DEFAULT_GATEWAY_URL = "http://127.0.0.1:8642"
DEFAULT_MANAGEMENT_URL = "http://127.0.0.1:8765"
DEFAULT_IRIS_GATEWAY_URL = "http://127.0.0.1:8766"
IRIS_GATEWAY_PORT_OFFSET = 124
GATEWAY_CONTROL_ACTIONS = {"status", "start", "stop", "restart"}
GATEWAY_CONTROL_TIMEOUT_SECONDS = 25
PROFILE_CLI_TIMEOUT_SECONDS = 90


def raise_memory_conflict() -> None:
    raise ManagementError(
        "Memory changed on disk. Refresh before saving so you do not overwrite newer notes.",
        status_code=409,
    )


def reset_expectation_for_file(
    expectations: dict[str, Any],
    file_key: str,
    file_name: str,
) -> tuple[bool, Any]:
    candidates = (file_key, file_name, file_name.lower())
    for candidate in candidates:
        if candidate in expectations:
            return True, expectations[candidate]
    return False, None


def iris_multipart_attachments(attachments: Any) -> list[dict[str, Any]]:
    if not isinstance(attachments, list) or not attachments:
        return []
    rows: list[dict[str, Any]] = []
    for item in attachments:
        if not isinstance(item, dict):
            continue
        storage_path = str(item.get("storagePath") or "").strip()
        if not storage_path:
            continue
        name = str(item.get("name") or "attachment").strip()
        rows.append({
            "id": str(item.get("id") or ""),
            "name": name,
            "kind": str(item.get("kind") or ""),
            "mimeType": normalized_runtime_mime_type(item),
            "size": item.get("size") if isinstance(item.get("size"), int) else -1,
            "sha256": str(item.get("sha256") or ""),
            "path": storage_path,
        })
    return rows


def iris_payload_attachment(attachment: dict[str, Any], field: str) -> dict[str, Any]:
    return {
        "field": field,
        "id": str(attachment.get("id") or ""),
        "name": str(attachment.get("name") or "attachment"),
        "kind": str(attachment.get("kind") or ""),
        "mimeType": normalized_runtime_mime_type(attachment),
        "size": attachment.get("size") if isinstance(attachment.get("size"), int) else -1,
        **({"sha256": attachment["sha256"]} if attachment.get("sha256") else {}),
    }


def local_runtime_config(*, management_url: str | None = None) -> dict[str, Any]:
    gateway_url = os.environ.get("HERMES_GATEWAY_URL") or DEFAULT_GATEWAY_URL
    default_iris_url = os.environ.get("IRIS_TO_HERMES_URL") or DEFAULT_IRIS_GATEWAY_URL
    return {
        "id": DEFAULT_RUNTIME_ID,
        "kind": "hermes",
        "name": "Local Hermes",
        "enabled": True,
        "connection": {
            "gatewayUrl": gateway_url,
            "managementUrl": management_url or os.environ.get("IRIS_CORE_API_URL") or DEFAULT_MANAGEMENT_URL,
            "irisGatewayUrls": {
                "default": default_iris_url,
            },
            "network": "local",
        },
    }


class HermesRuntimeAdapter:
    kind = "hermes"

    def __init__(
        self,
        runtime: dict[str, Any],
        *,
        hermes_store: HermesStore | None = None,
        hermes_home: str | os.PathLike[str] | None = None,
        core_store: CoreStore | None = None,
        iris_token: str = "",
        hermes_api_token: str = "",
    ) -> None:
        self.runtime = runtime
        self.hermes_store = hermes_store
        self.hermes_home = hermes_home
        self.core_store = core_store
        self.token = iris_token
        self.hermes_api_token = hermes_api_token
        self.connection = runtime.get("connection") if isinstance(runtime.get("connection"), dict) else {}

    @property
    def runtime_id(self) -> str:
        return str(self.runtime.get("id") or DEFAULT_RUNTIME_ID)

    def list_agents(self) -> list[dict[str, Any]]:
        store = self.require_store()
        profiles = store.profiles()
        active_profile = next((profile.name for profile in profiles if profile.active), "default")
        return [agent_from_profile_summary(self.runtime, profile, active_profile) for profile in profiles]

    def get_agent(self, agent_id: str) -> dict[str, Any] | None:
        return next((agent for agent in self.list_agents() if agent["id"] == agent_id), None)

    def create_agent(
        self,
        name: str,
        metadata: dict[str, Any] | None = None,
        *,
        create_alias: bool = False,
        no_alias: bool = False,
        no_skills: bool = False,
    ) -> dict[str, Any]:
        del metadata
        store = self.require_store()
        profile, warnings = store.create_profile(name, no_skills=no_skills)
        if create_alias and not no_alias:
            try:
                store.create_alias(profile.name)
            except ManagementError as exc:
                warnings.append(exc.error)
        return self.mutation_result(self.require_agent_profile(profile.name), warnings=warnings, restart_required=True)

    def clone_agent(
        self,
        source_agent: dict[str, Any],
        name: str,
        *,
        clone_mode: str = "identity",
        create_alias: bool = False,
        no_alias: bool = False,
        no_skills: bool = False,
    ) -> dict[str, Any]:
        del no_skills
        store = self.require_store()
        profile, warnings = store.clone_profile(str(source_agent["runtimeProfile"]), name, clone_mode=clone_mode)
        if create_alias and not no_alias:
            try:
                store.create_alias(profile.name)
            except ManagementError as exc:
                warnings.append(exc.error)
        return self.mutation_result(self.require_agent_profile(profile.name), warnings=warnings, restart_required=True)

    def rename_agent(self, agent: dict[str, Any], name: str) -> dict[str, Any]:
        old_profile = str(agent["runtimeProfile"])
        new_profile = normalize_profile_name(name)
        warnings: list[str] = []
        command = self.run_hermes_profile_cli(["profile", "rename", old_profile, new_profile])
        if command.get("missing"):
            stop_result = self.gateway_control(old_profile, "stop")
            if not stop_result.get("ok"):
                warnings.append("Hermes CLI was unavailable, and Iris could not confirm the gateway stopped before fallback rename.")
            warnings.append("Hermes CLI was unavailable. Iris renamed the profile directly; CLI aliases, services, and Honcho host state may need Hermes cleanup.")
            self.require_store().rename_profile(old_profile, new_profile)
        elif not command.get("ok"):
            raise ManagementError(command.get("error") or "Hermes profile rename failed.", status_code=400)
        if self.core_store:
            self.core_store.rename_memory_revisions_profile(
                runtime_id=self.runtime_id,
                old_profile=old_profile,
                new_profile=new_profile,
            )
            self.core_store.rename_runtime_profile_port(
                runtime_id=self.runtime_id,
                old_profile=old_profile,
                new_profile=new_profile,
                default_port=default_iris_gateway_port(),
            )
        return self.mutation_result(self.require_agent_profile(new_profile), warnings=warnings, restart_required=True)

    def activate_agent(self, agent: dict[str, Any]) -> dict[str, Any]:
        self.require_store().activate_profile(str(agent["runtimeProfile"]))
        refreshed = self.get_agent(str(agent["id"])) or self.require_agent_profile(str(agent["runtimeProfile"]))
        return self.mutation_result({**refreshed, "isDefault": True})

    def delete_agent(self, agent: dict[str, Any]) -> dict[str, Any]:
        profile = str(agent["runtimeProfile"])
        if profile == "default":
            self.require_store().delete_profile(profile)
        warnings: list[str] = []
        command = self.run_hermes_profile_cli(["profile", "delete", profile, "-y"])
        if command.get("missing"):
            stop_result = self.gateway_control(profile, "stop")
            if not stop_result.get("ok"):
                warnings.append("Hermes CLI was unavailable, and Iris could not confirm the gateway stopped before fallback delete.")
            warnings.append("Hermes CLI was unavailable. Iris deleted the profile directory directly; CLI aliases and gateway service cleanup may need Hermes cleanup.")
            next_profile = self.require_store().delete_profile(profile)
        elif command.get("ok"):
            next_profile = self.require_store().active_profile_name()
        else:
            raise ManagementError(command.get("error") or "Hermes profile delete failed.", status_code=400)
        if self.core_store:
            self.core_store.delete_memory_revisions_for_profile(
                runtime_id=self.runtime_id,
                runtime_profile=profile,
            )
            self.core_store.mark_runtime_profile_port_deleted(
                runtime_id=self.runtime_id,
                runtime_profile=profile,
            )
        return self.mutation_result(self.require_agent_profile(next_profile), warnings=warnings, restart_required=True)

    def mutation_result(
        self,
        agent: dict[str, Any],
        *,
        warnings: list[str] | None = None,
        restart_required: bool = False,
        adapter_install_required: bool = False,
    ) -> dict[str, Any]:
        profile = str(agent.get("runtimeProfile") or "")
        return {
            "agent": agent,
            "profile": profile,
            "warnings": [warning for warning in (warnings or []) if warning],
            "restartRequired": restart_required,
            "adapterInstallRequired": adapter_install_required,
        }

    def require_agent_profile(self, profile: str) -> dict[str, Any]:
        agent = next((row for row in self.list_agents() if row["runtimeProfile"] == profile), None)
        if not agent:
            raise ManagementError("Agent was not found.", status_code=404)
        return agent

    def agent_memory(self, agent: dict[str, Any]) -> dict[str, Any]:
        profile = str(agent["runtimeProfile"])
        store = self.require_store()
        memory_file, user_file = store.memory_files(profile)
        directory = store.profile_directory(profile)
        history = []
        if self.core_store:
            history = self.core_store.list_memory_revisions(
                runtime_id=self.runtime_id,
                runtime_profile=profile,
                limit=100,
            )
        return {
            "ok": True,
            "profile": profile,
            "path": str(directory / "memories"),
            "files": [memory_file, user_file],
            "memory": memory_file,
            "user": user_file,
            "history": history,
        }

    def save_agent_memory(
        self,
        agent: dict[str, Any],
        file: str,
        content: str,
        expected_updated_at: int | None = None,
        expected_content_hash: str | None = None,
    ) -> dict[str, Any]:
        profile = str(agent["runtimeProfile"])
        store = self.require_store()
        file_key = normalized_memory_file_key(file)
        current = self.memory_file_payload(store, profile, file_key)
        self.check_memory_expectations(
            current=current,
            expected_updated_at=expected_updated_at,
            expected_content_hash=expected_content_hash,
        )
        if current.exists and current.content != content and self.core_store:
            self.core_store.create_memory_revision(
                runtime_id=self.runtime_id,
                runtime_profile=profile,
                file_key=file_key,
                file_name=memory_file_name(file_key),
                action="save",
                content=current.content,
                file_updated_at=current.updatedAt,
                summary="Before Iris save",
                metadata={
                    "source": "iris",
                    "operation": "save",
                    "expectedUpdatedAt": expected_updated_at,
                    "expectedContentHash": expected_content_hash,
                },
            )
        if current.content != content:
            store.save_memory_file(
                profile,
                file_key,
                content,
                expected_updated_at=expected_updated_at,
                expected_content_hash=expected_content_hash,
            )
        return self.agent_memory(agent)

    def reset_agent_memory(
        self,
        agent: dict[str, Any],
        file: str,
        expected_updated_at: int | None = None,
        expected_updated_at_by_file: dict[str, int | None] | None = None,
        expected_content_hash: str | None = None,
        expected_content_hash_by_file: dict[str, str | None] | None = None,
    ) -> dict[str, Any]:
        profile = str(agent["runtimeProfile"])
        store = self.require_store()
        normalized = file.strip().lower()
        targets = ["memory", "user"] if normalized == "all" else [normalized_memory_file_key(file)]
        current_by_file = {
            file_key: self.memory_file_payload(store, profile, file_key)
            for file_key in targets
        }
        for file_key, current in current_by_file.items():
            file_expected_updated_at = reset_expectation_for_file(
                expected_updated_at_by_file or {},
                file_key,
                memory_file_name(file_key),
            )
            file_expected_content_hash = reset_expectation_for_file(
                expected_content_hash_by_file or {},
                file_key,
                memory_file_name(file_key),
            )
            self.check_memory_expectations(
                current=current,
                expected_updated_at=file_expected_updated_at[1]
                if file_expected_updated_at[0]
                else expected_updated_at if len(targets) == 1 else None,
                expected_content_hash=file_expected_content_hash[1]
                if file_expected_content_hash[0]
                else expected_content_hash if len(targets) == 1 else None,
                expected_updated_at_provided=file_expected_updated_at[0]
                or (expected_updated_at is not None and len(targets) == 1),
                expected_content_hash_provided=file_expected_content_hash[0]
                or (expected_content_hash is not None and len(targets) == 1),
            )
        if self.core_store:
            for file_key, current in current_by_file.items():
                if not current.exists:
                    continue
                self.core_store.create_memory_revision(
                    runtime_id=self.runtime_id,
                    runtime_profile=profile,
                    file_key=file_key,
                    file_name=memory_file_name(file_key),
                    action="reset",
                    content=current.content,
                    file_updated_at=current.updatedAt,
                    summary="Before Iris reset",
                    metadata={
                        "source": "iris",
                        "operation": "reset",
                        "target": normalized,
                    },
                )
        store.reset_memory_file(profile, normalized)
        return self.agent_memory(agent)

    def memory_file_payload(self, store: HermesStore, profile: str, file_key: str):
        memory_file, user_file = store.memory_files(profile)
        return memory_file if file_key == "memory" else user_file

    def check_memory_expectations(
        self,
        *,
        current: Any,
        expected_updated_at: int | None = None,
        expected_content_hash: str | None = None,
        expected_updated_at_provided: bool | None = None,
        expected_content_hash_provided: bool | None = None,
    ) -> None:
        hash_provided = (
            expected_content_hash is not None
            if expected_content_hash_provided is None
            else expected_content_hash_provided
        )
        if hash_provided:
            if expected_content_hash is None:
                if current.exists:
                    raise_memory_conflict()
                return
            if current.contentHash != expected_content_hash:
                raise_memory_conflict()
            return

        timestamp_provided = (
            expected_updated_at is not None
            if expected_updated_at_provided is None
            else expected_updated_at_provided
        )
        if timestamp_provided and current.updatedAt != expected_updated_at:
            raise_memory_conflict()

    def list_agent_skills(self, agent: dict[str, Any]) -> dict[str, Any]:
        profile = str(agent["runtimeProfile"])
        store = self.require_store()
        directory = store.profile_directory(profile)
        return {
            "ok": True,
            "profile": profile,
            "path": str(directory / "skills"),
            "skills": store.skills(profile),
        }

    def list_agent_skill_catalog(self, agent: dict[str, Any]) -> dict[str, Any]:
        profile = str(agent["runtimeProfile"])
        agents_by_profile = {
            str(row.get("runtimeProfile") or ""): row
            for row in self.list_agents()
        }
        return self.require_store().skill_catalog(profile, agents_by_profile=agents_by_profile)

    def get_agent_skill(self, agent: dict[str, Any], skill_id: str) -> dict[str, Any]:
        profile = str(agent["runtimeProfile"])
        summary, content = self.require_store().skill_detail(profile, skill_id)
        return {"ok": True, "profile": profile, "content": content, "history": [], **summary.model_dump()}

    def create_agent_skill(self, agent: dict[str, Any], payload: dict[str, Any]) -> dict[str, Any]:
        profile = str(agent["runtimeProfile"])
        summary, content = self.require_store().save_skill(profile, payload)
        return {"ok": True, "profile": profile, "skill": {"content": content, "history": [], **summary.model_dump()}}

    def install_agent_skill(self, agent: dict[str, Any], payload: dict[str, Any]) -> dict[str, Any]:
        profile = str(agent["runtimeProfile"])
        source_agent_id = str(payload.get("sourceAgentId") or "").strip()
        if source_agent_id and not str(payload.get("sourceProfile") or "").strip():
            source_agent = self.get_agent(source_agent_id)
            if not source_agent:
                raise ManagementError("Source agent was not found.", status_code=404)
            payload = {**payload, "sourceProfile": str(source_agent["runtimeProfile"])}
        summary, content = self.require_store().install_skill(profile, payload)
        return {"ok": True, "profile": profile, "skill": {"content": content, "history": [], **summary.model_dump()}}

    def save_agent_skill(self, agent: dict[str, Any], skill_id: str, payload: dict[str, Any]) -> dict[str, Any]:
        profile = str(agent["runtimeProfile"])
        summary, content = self.require_store().save_skill(profile, payload, skill_id)
        return {"ok": True, "profile": profile, "skill": {"content": content, "history": [], **summary.model_dump()}}

    def delete_agent_skill(self, agent: dict[str, Any], skill_id: str, payload: dict[str, Any] | None = None) -> dict[str, Any]:
        del payload
        profile = str(agent["runtimeProfile"])
        result = self.require_store().delete_skill(profile, skill_id)
        return {"ok": True, "profile": profile, **result}

    def profile_identity(self, agent: dict[str, Any]) -> dict[str, Any]:
        return self.require_store().profile_identity(str(agent["runtimeProfile"]))

    def profile_soul(self, agent: dict[str, Any]) -> dict[str, Any]:
        profile = str(agent["runtimeProfile"])
        payload = self.require_store().read_profile_file(profile, "SOUL.md")
        return {"ok": True, "profile": profile, **payload.model_dump()}

    def save_profile_soul(self, agent: dict[str, Any], content: str, expected_content_hash: str | None = None) -> dict[str, Any]:
        profile = str(agent["runtimeProfile"])
        payload = self.require_store().write_profile_file(profile, "SOUL.md", content, expected_content_hash)
        return {"ok": True, "profile": profile, **payload.model_dump()}

    def reset_profile_soul(self, agent: dict[str, Any], expected_content_hash: str | None = None) -> dict[str, Any]:
        profile = str(agent["runtimeProfile"])
        payload = self.require_store().reset_soul_file(profile, expected_content_hash)
        return {"ok": True, "profile": profile, **payload.model_dump()}

    def profile_config(self, agent: dict[str, Any]) -> dict[str, Any]:
        return self.require_store().profile_config(str(agent["runtimeProfile"]))

    def save_profile_config(self, agent: dict[str, Any], content: str, expected_content_hash: str | None = None) -> dict[str, Any]:
        profile = str(agent["runtimeProfile"])
        payload = self.require_store().write_profile_file(profile, "config.yaml", content, expected_content_hash)
        return {"ok": True, "profile": profile, **self.require_store().profile_config(profile), "contentHash": payload.contentHash}

    def profile_env(self, agent: dict[str, Any]) -> dict[str, Any]:
        return self.require_store().profile_env(str(agent["runtimeProfile"]))

    def update_profile_env(self, agent: dict[str, Any], values: dict[str, str], remove_keys: list[str]) -> dict[str, Any]:
        return self.require_store().update_profile_env(str(agent["runtimeProfile"]), values, remove_keys)

    def profile_config_check(self, agent: dict[str, Any]) -> dict[str, Any]:
        profile = str(agent["runtimeProfile"])
        commands = {
            "check": ["--profile", profile, "config", "check"],
            "path": ["--profile", profile, "config", "path"],
            "envPath": ["--profile", profile, "config", "env-path"],
        }
        results = {
            key: self.run_hermes_profile_cli(argv, timeout=30)
            for key, argv in commands.items()
        }
        ok = all(item.get("ok") for item in results.values())
        return {
            "ok": ok,
            "profile": profile,
            "commands": results,
            **({} if ok else {"error": next((item.get("error") for item in results.values() if item.get("error")), "Hermes config diagnostics failed.")}),
        }

    def export_profile(self, agent: dict[str, Any], output_path: Path) -> tuple[Path, list[str]]:
        profile = str(agent["runtimeProfile"])
        warnings: list[str] = []
        command = self.run_hermes_profile_cli(["profile", "export", profile, "-o", str(output_path)])
        if command.get("missing"):
            warnings.append("Hermes CLI was unavailable. Iris exported the profile with its built-in safe archive fallback.")
            return self.require_store().export_profile(profile, output_path), warnings
        if not command.get("ok"):
            raise ManagementError(command.get("error") or "Hermes profile export failed.", status_code=400)
        return output_path, warnings

    def import_profile(self, archive_path: Path, name: str = "") -> dict[str, Any]:
        target = normalize_profile_name(name) if name else normalize_profile_name(inspect_archive_root(archive_path))
        warnings: list[str] = []
        args = ["profile", "import", str(archive_path)]
        if target:
            args.extend(["--name", target])
        command = self.run_hermes_profile_cli(args)
        if command.get("missing"):
            profile, fallback_warnings = self.require_store().import_profile(archive_path, target)
            warnings.extend(fallback_warnings)
            warnings.append("Hermes CLI was unavailable. Iris imported the profile with its built-in safe archive fallback.")
        elif command.get("ok"):
            profile = self.require_store().profile_summary(target)
        else:
            raise ManagementError(command.get("error") or "Hermes profile import failed.", status_code=400)
        return self.mutation_result(self.require_agent_profile(profile.name), warnings=warnings, restart_required=True)

    def install_distribution(self, *, source: str, name: str = "", alias: bool = False, force: bool = False) -> dict[str, Any]:
        target = normalize_profile_name(name) if name else ""
        warnings: list[str] = []
        args = ["profile", "install", source, "-y"]
        if target:
            args.extend(["--name", target])
        if alias:
            args.append("--alias")
        if force:
            args.append("--force")
        command = self.run_hermes_profile_cli(args, timeout=180)
        if command.get("missing"):
            profile, details, fallback_warnings = self.require_store().install_distribution(source=source, name=target, force=force)
            warnings.extend(fallback_warnings)
            warnings.append("Hermes CLI was unavailable. Iris installed the distribution with its built-in local fallback.")
            if alias:
                try:
                    self.require_store().create_alias(profile.name)
                except ManagementError as exc:
                    warnings.append(exc.error)
        elif command.get("ok"):
            profile_name = target or self.profile_name_from_distribution_source(source)
            profile = self.require_store().profile_summary(profile_name)
            details = {"stdout": command.get("stdout", "")}
        else:
            raise ManagementError(command.get("error") or "Hermes profile distribution install failed.", status_code=400)
        result = self.mutation_result(self.require_agent_profile(profile.name), warnings=warnings, restart_required=True)
        return {**result, "distribution": details}

    def update_distribution(self, agent: dict[str, Any], *, force_config: bool = False) -> dict[str, Any]:
        profile = str(agent["runtimeProfile"])
        warnings: list[str] = []
        args = ["profile", "update", profile, "-y"]
        if force_config:
            args.append("--force-config")
        command = self.run_hermes_profile_cli(args, timeout=180)
        if command.get("missing"):
            result = self.require_store().update_distribution(profile, force_config=force_config)
            warnings.append("Hermes CLI was unavailable. Iris updated distribution-owned files with its built-in local fallback.")
        elif command.get("ok"):
            result = self.require_store().distribution_info(profile)
            result["stdout"] = command.get("stdout", "")
        else:
            raise ManagementError(command.get("error") or "Hermes profile distribution update failed.", status_code=400)
        return {"ok": True, "profile": profile, "warnings": warnings, "restartRequired": True, **result}

    def distribution_info(self, agent: dict[str, Any]) -> dict[str, Any]:
        return self.require_store().distribution_info(str(agent["runtimeProfile"]))

    def profile_alias(self, agent: dict[str, Any]) -> dict[str, Any]:
        return self.require_store().alias_status(str(agent["runtimeProfile"]))

    def create_profile_alias(self, agent: dict[str, Any], alias: str = "") -> dict[str, Any]:
        return self.require_store().create_alias(str(agent["runtimeProfile"]), alias)

    def remove_profile_alias(self, agent: dict[str, Any], alias: str = "") -> dict[str, Any]:
        return self.require_store().remove_alias(str(agent["runtimeProfile"]), alias)

    def profile_name_from_distribution_source(self, source: str) -> str:
        with tempfile.TemporaryDirectory(prefix="iris_dist_name_") as tmpdir:
            staged, _provenance = stage_distribution_source(source, Path(tmpdir))
            manifest = distribution_manifest(staged / "distribution.yaml", staged)
            if not manifest or not manifest.get("name"):
                raise ManagementError("Distribution manifest is missing a name.", status_code=400)
            return normalize_profile_name(str(manifest["name"]))

    def list_sessions(self, agent: dict[str, Any], limit: int = 80) -> list[dict[str, Any]]:
        store = self.require_store()
        result = store.sessions(str(agent["runtimeProfile"]), limit)
        return [session_from_runtime_summary(agent, session) for session in result.sessions]

    def get_session(
        self,
        agent: dict[str, Any],
        external_id: str = "",
        *,
        chat_id: str = "",
        session_id: str = "",
    ) -> dict[str, Any] | None:
        external_id = str(external_id or "").strip()
        chat_id = str(chat_id or "").strip()
        if external_id or chat_id:
            sessions = self.get_sessions_by_external_refs(
                agent,
                external_session_ids=[external_id] if external_id else [],
                external_chat_ids=[chat_id] if chat_id else [],
            )
            for session in sessions:
                if external_id and session["externalSessionId"] == external_id:
                    return session
            for session in sessions:
                if chat_id and session["externalChatId"] == chat_id:
                    return session
            for session in sessions:
                if session_id and session["id"] == session_id:
                    return session
            return sessions[0] if sessions else None
        for session in self.list_sessions(agent, 200):
            if session_id and session["id"] == session_id:
                return session
            if chat_id and session["externalChatId"] == chat_id:
                return session
        return None

    def get_sessions_by_external_refs(
        self,
        agent: dict[str, Any],
        *,
        external_session_ids: list[str] | set[str] | tuple[str, ...] = (),
        external_chat_ids: list[str] | set[str] | tuple[str, ...] = (),
    ) -> list[dict[str, Any]]:
        profile = str(agent["runtimeProfile"])
        session_ids = {str(item or "").strip() for item in external_session_ids if str(item or "").strip()}
        chat_ids = {str(item or "").strip() for item in external_chat_ids if str(item or "").strip()}
        if not session_ids and not chat_ids:
            return []
        summaries = self.require_store().session_summaries(
            profile,
            session_ids=session_ids,
            chat_ids=chat_ids,
        )
        return [session_from_runtime_summary(agent, summary) for summary in summaries]

    def latest_cron_session_for_job(self, agent: dict[str, Any], job_id: str) -> dict[str, Any] | None:
        clean_job_id = "".join(char for char in str(job_id or "").strip() if char in "0123456789abcdefABCDEF")
        if not clean_job_id:
            return None
        profile = str(agent["runtimeProfile"])
        directory = self.require_store().profile_directory(profile)
        candidates: list[tuple[float, str]] = []

        db_path = directory / "state.db"
        if db_path.is_file():
            try:
                connection = sqlite3.connect(f"file:{db_path.as_posix()}?mode=ro", uri=True)
                connection.row_factory = sqlite3.Row
                rows = connection.execute(
                    """
                    select id, coalesce(ended_at, started_at, 0) as active_at
                    from sessions
                    where id like ?
                    order by coalesce(ended_at, started_at, 0) desc
                    limit 5
                    """,
                    (f"cron_{clean_job_id}_%",),
                ).fetchall()
                candidates.extend((float(row["active_at"] or 0), str(row["id"])) for row in rows)
            except sqlite3.Error:
                pass
            finally:
                try:
                    connection.close()  # type: ignore[has-type]
                except Exception:
                    pass

        sessions_dir = directory / "sessions"
        if sessions_dir.is_dir():
            for path in sessions_dir.glob(f"session_cron_{clean_job_id}_*.json"):
                try:
                    payload = json.loads(path.read_text(encoding="utf-8"))
                except (OSError, UnicodeDecodeError, json.JSONDecodeError):
                    continue
                session_id = str(payload.get("session_id") or "").strip()
                if session_id:
                    candidates.append((float(path.stat().st_mtime), session_id))

        for _, session_id in sorted(candidates, reverse=True):
            session = self.get_cron_session_by_id(agent, session_id)
            if session:
                return session
        return None

    def get_cron_session_by_id(self, agent: dict[str, Any], session_id: str) -> dict[str, Any] | None:
        clean_session_id = str(session_id or "").strip()
        if not clean_session_id.startswith("cron_"):
            return None
        try:
            detail = self.require_store().session_detail(str(agent["runtimeProfile"]), clean_session_id)
        except ManagementError:
            return None
        return session_from_runtime_summary(agent, detail.session)

    def rename_session(
        self,
        agent: dict[str, Any],
        session: dict[str, Any],
        title: str,
    ) -> dict[str, Any]:
        clean_title = title.strip()
        if not clean_title:
            raise ManagementError("Session title is required.", status_code=400)
        external_session_id = str(session.get("externalSessionId") or "").strip()
        if not external_session_id:
            return {**session, "title": clean_title, "updatedAt": int(time.time())}
        detail = self.require_store().rename_session(
            str(agent["runtimeProfile"]),
            external_session_id,
            clean_title,
        )
        return session_from_runtime_summary(agent, detail.session)

    def delete_session(
        self,
        agent: dict[str, Any],
        session: dict[str, Any],
    ) -> dict[str, Any]:
        external_session_id = str(session.get("externalSessionId") or "").strip()
        if external_session_id:
            self.require_store().delete_session(str(agent["runtimeProfile"]), external_session_id)
        return session

    def get_session_messages(
        self,
        agent: dict[str, Any],
        external_id: str = "",
        *,
        chat_id: str = "",
        session_id: str = "",
    ) -> tuple[list[dict[str, Any]], str | None]:
        if str(external_id or "").strip().startswith("cron_"):
            session = self.get_cron_session_by_id(agent, str(external_id or "").strip())
            if session and session_id:
                session = {**session, "id": session_id, "externalChatId": chat_id or session.get("externalChatId") or ""}
        else:
            session = self.get_session(
                agent,
                external_id,
                chat_id=chat_id,
                session_id=session_id,
            )
        if not session or not session["externalSessionId"]:
            return [], None
        detail = self.require_store().session_detail(
            str(agent["runtimeProfile"]),
            str(session["externalSessionId"]),
        )
        core_session_id = session_id or str(session["id"])
        messages = [
            {**core_message_from_hermes(message), "sessionId": core_session_id}
            for message in detail.messages
        ]
        return self.with_client_message_metadata(
            messages,
            profile=str(agent["runtimeProfile"]),
            chat_id=str(session["externalChatId"] or ""),
        ), detail.warning

    def with_client_message_metadata(
        self,
        messages: list[dict[str, Any]],
        *,
        profile: str,
        chat_id: str,
    ) -> list[dict[str, Any]]:
        if not self.core_store or not chat_id:
            return messages
        overlays = self.core_store.client_message_metadata_for_messages(
            runtime_id=str(self.runtime["id"]),
            profile=profile,
            chat_id=chat_id,
            messages=messages,
        )
        by_message_id = overlays["byMessageId"]
        by_content_hash = overlays["byContentHash"]
        attachment_fallbacks = overlays.get("attachmentFallbacks", [])
        used_attachment_fallbacks: set[str] = set()
        # C3: deterministic assistant correlation. Each finalized stream wrote an
        # overlay carrying the clientRequestId / streamMessageId it streamed under;
        # we consume them in transcript order so two identical replies resolve to
        # distinct overlays positionally instead of being dropped on a hash clash.
        assistant_overlays = self.core_store.assistant_message_metadata_for_messages(
            runtime_id=str(self.runtime["id"]),
            profile=profile,
            chat_id=chat_id,
            messages=messages,
        )
        assistant_by_content_hash = assistant_overlays["byContentHash"]
        assistant_by_normalized = assistant_overlays["byNormalizedContent"]
        consumed_assistant_overlays: set[str] = set()

        def consume_assistant_overlay(content: str) -> dict[str, Any] | None:
            def take(bucket: list[dict[str, Any]] | None) -> dict[str, Any] | None:
                while bucket:
                    candidate = bucket.pop(0)
                    if candidate["streamMessageId"] not in consumed_assistant_overlays:
                        consumed_assistant_overlays.add(candidate["streamMessageId"])
                        return candidate
                return None

            for content_hash in message_content_hash_candidates(content):
                overlay = take(assistant_by_content_hash.get(content_hash))
                if overlay:
                    return overlay
            return take(assistant_by_normalized.get(normalize_assistant_content(content)))

        enriched: list[dict[str, Any]] = []
        for message in messages:
            role = str(message.get("role") or "")
            if role not in {"user", "assistant"}:
                enriched.append(message)
                continue
            overlay = by_message_id.get(str(message.get("id") or ""))
            metadata = message.get("metadata") if isinstance(message.get("metadata"), dict) else {}
            stream_message_id = str(metadata.get("streamMessageId") or metadata.get("stream_message_id") or "")
            if not overlay and stream_message_id:
                overlay = by_message_id.get(stream_message_id)
            if not overlay:
                overlay = next(
                    (
                        by_content_hash[content_hash]
                        for content_hash in message_content_hash_candidates(str(message.get("content") or ""))
                        if content_hash in by_content_hash
                    ),
                    None,
                )
            if not overlay:
                fallback = next(
                    (
                        item
                        for item in attachment_fallbacks
                        if str(item.get("messageId") or "") not in used_attachment_fallbacks
                    ),
                    None,
                ) if (
                    role == "user" and
                    is_transformed_voice_message_content(str(message.get("content") or ""))
                ) else None
                if fallback and isinstance(fallback.get("metadata"), dict):
                    used_attachment_fallbacks.add(str(fallback.get("messageId") or ""))
                    overlay = fallback["metadata"]
            assistant_overlay = (
                consume_assistant_overlay(str(message.get("content") or "")) if role == "assistant" else None
            )
            if not overlay and not assistant_overlay:
                enriched.append(message)
                continue
            content = str(message.get("content") or "")
            next_metadata = {**metadata}
            if overlay:
                client_content = overlay.get("clientContent")
                if isinstance(client_content, str):
                    content = client_content
                elif (
                    role == "user" and
                    isinstance(overlay.get("attachments"), list) and
                    is_transformed_voice_message_content(content)
                ):
                    content = ""
                next_metadata = {**next_metadata, **overlay}
            if assistant_overlay:
                # The streamed correlation identity is authoritative for dedupe.
                if assistant_overlay.get("clientRequestId"):
                    next_metadata["clientRequestId"] = assistant_overlay["clientRequestId"]
                if assistant_overlay.get("streamMessageId"):
                    next_metadata["streamMessageId"] = assistant_overlay["streamMessageId"]
                if assistant_overlay.get("replyTo"):
                    next_metadata["replyTo"] = assistant_overlay["replyTo"]
            enriched.append({**message, "content": content, "metadata": next_metadata})
        return enriched

    def probe(self, profile: str = "default") -> dict[str, Any]:
        gateway_url = str(self.connection.get("gatewayUrl") or DEFAULT_GATEWAY_URL)
        management_url = str(self.connection.get("managementUrl") or DEFAULT_MANAGEMENT_URL)
        adapter_url = self.iris_gateway_url(profile)
        adapter_probe = probe_endpoint(f"{adapter_url.rstrip('/')}/health", expected_profile=profile)
        return {
            "gateway": probe_endpoint(gateway_url),
            "management": probe_endpoint(f"{management_url.rstrip('/')}/health"),
            "irisAdapter": {
                **adapter_probe,
                "profile": adapter_probe.get("profile") or profile,
                "requestedProfile": profile,
            },
        }

    def gateway_status(self, profile: str) -> dict[str, Any]:
        return self.gateway_control(profile, "status")

    def run_hermes_profile_cli(self, args: list[str], *, timeout: int = PROFILE_CLI_TIMEOUT_SECONDS) -> dict[str, Any]:
        hermes = self.resolve_hermes_executable()
        if not hermes:
            return {
                "ok": False,
                "missing": True,
                "stdout": "",
                "stderr": "",
                "status": None,
                "error": "Hermes CLI was not found.",
            }
        env = os.environ.copy()
        if self.hermes_home:
            env["HERMES_HOME"] = str(normalize_hermes_home(self.hermes_home))
        try:
            completed = subprocess.run(
                [hermes, *args],
                shell=False,
                capture_output=True,
                text=True,
                timeout=timeout,
                env=env,
            )
        except subprocess.TimeoutExpired as exc:
            return {
                "ok": False,
                "missing": False,
                "stdout": str(exc.stdout or ""),
                "stderr": str(exc.stderr or ""),
                "status": None,
                "error": f"Hermes CLI timed out after {timeout} seconds.",
            }
        except OSError as exc:
            return {
                "ok": False,
                "missing": False,
                "stdout": "",
                "stderr": "",
                "status": None,
                "error": str(exc),
            }
        stdout = completed.stdout or ""
        stderr = completed.stderr or ""
        return {
            "ok": completed.returncode == 0,
            "missing": False,
            "stdout": stdout,
            "stderr": stderr,
            "status": completed.returncode,
            **({} if completed.returncode == 0 else {"error": stderr.strip() or stdout.strip() or "Hermes CLI command failed."}),
        }

    def gateway_control(self, profile: str, action: str) -> dict[str, Any]:
        clean_profile = validate_profile_name(str(profile or "default"))
        clean_action = str(action or "").strip().lower()
        if clean_action not in GATEWAY_CONTROL_ACTIONS:
            return {
                "ok": False,
                "stdout": "",
                "stderr": "",
                "status": None,
                "error": f"Unsupported Hermes gateway action: {clean_action or 'unknown'}.",
            }

        hermes = self.resolve_hermes_executable()
        if not hermes:
            return {
                "ok": False,
                "stdout": "",
                "stderr": "",
                "status": None,
                "error": "Hermes CLI was not found. Add hermes to PATH or configure HERMES_HOME for Iris Core.",
            }

        argv = [hermes, "--profile", clean_profile, "gateway", clean_action]
        env = os.environ.copy()
        if self.hermes_home:
            env["HERMES_HOME"] = str(normalize_hermes_home(self.hermes_home))

        try:
            completed = subprocess.run(
                argv,
                shell=False,
                capture_output=True,
                text=True,
                timeout=GATEWAY_CONTROL_TIMEOUT_SECONDS,
                env=env,
            )
        except subprocess.TimeoutExpired as exc:
            return {
                "ok": False,
                "stdout": str(exc.stdout or ""),
                "stderr": str(exc.stderr or ""),
                "status": None,
                "error": f"Hermes gateway {clean_action} timed out after {GATEWAY_CONTROL_TIMEOUT_SECONDS} seconds.",
            }
        except OSError as exc:
            return {
                "ok": False,
                "stdout": "",
                "stderr": "",
                "status": None,
                "error": str(exc),
            }

        stdout = completed.stdout or ""
        stderr = completed.stderr or ""
        return {
            "ok": completed.returncode == 0,
            "stdout": stdout,
            "stderr": stderr,
            "status": completed.returncode,
            **({} if completed.returncode == 0 else {"error": stderr.strip() or stdout.strip() or f"Hermes gateway {clean_action} failed."}),
        }

    def resolve_hermes_executable(self) -> str:
        found = shutil.which("hermes")
        if found:
            return found
        if self.hermes_home:
            home = normalize_hermes_home(self.hermes_home)
            for candidate in (
                home / "hermes-agent" / "venv" / "bin" / "hermes",
                home / "venv" / "bin" / "hermes",
            ):
                if candidate.is_file() and os.access(candidate, os.X_OK):
                    return str(candidate)
        return ""

    def send_message(
        self,
        *,
        profile: str,
        chat_id: str,
        chat_name: str,
        message_id: str,
        text: str,
        session_id: str = "",
        user_id: str = "iris-user",
        user_name: str = "Iris User",
        metadata: dict[str, Any] | None = None,
        attachments: list[dict[str, Any]] | None = None,
    ) -> dict[str, Any]:
        adapter_url = self.iris_gateway_url(profile)
        if not self.token and not url_is_loopback(adapter_url):
            return {"ok": False, "error": f"Iris Desktop remote access uses SSH to a loopback Core. Configure the Hermes adapter with a loopback IRIS_BASE_URL on the Hermes host instead of {adapter_url}."}
        url = f"{adapter_url.rstrip('/')}/iris/messages"
        metadata_payload = metadata if isinstance(metadata, dict) else {}
        client_request_id = str(
            metadata_payload.get("clientRequestId")
            or metadata_payload.get("client_request_id")
            or metadata_payload.get("clientMessageId")
            or metadata_payload.get("client_message_id")
            or message_id
        ).strip()
        if client_request_id:
            metadata_payload = {**metadata_payload, "clientRequestId": client_request_id}
        multipart_attachments = iris_multipart_attachments(attachments or [])
        body: dict[str, Any] = {
            "chatId": chat_id,
            "chatName": chat_name or chat_id,
            "profile": profile,
            "userId": user_id,
            "userName": user_name,
            "messageId": message_id,
            "text": text,
        }
        if session_id:
            body["sessionId"] = session_id
        if multipart_attachments:
            files: list[dict[str, Any]] = []
            payload_attachments: list[dict[str, Any]] = []
            for index, attachment in enumerate(multipart_attachments):
                field = f"file_{index}"
                payload_attachments.append(iris_payload_attachment(attachment, field))
                files.append({
                    "field": field,
                    "path": attachment["path"],
                    "name": str(attachment.get("name") or f"attachment-{index}"),
                    "mimeType": normalized_runtime_mime_type(attachment),
                })
            body["attachments"] = payload_attachments
        if metadata_payload:
            body["metadata"] = metadata_payload
        if multipart_attachments:
            result = http_multipart(url, method="POST", token=self.token, payload=body, files=files)
        else:
            result = http_json(url, method="POST", token=self.token, body=body)
        if not result.get("ok"):
            return {
                "ok": False,
                "url": result.get("url") or url,
                "status": result.get("status"),
                "error": result.get("error") or "Iris gateway message failed.",
            }
        parsed = result.get("json") if isinstance(result.get("json"), dict) else {}
        if parsed.get("ok") is False:
            return {**parsed, "url": result.get("url") or url, "status": result.get("status")}
        return {
            **parsed,
            "ok": True,
            "profile": str(parsed.get("profile") or profile),
            "url": result.get("url") or url,
            "status": result.get("status"),
        }

    def models(self, profile: str, max_models: int = 100) -> dict[str, Any]:
        adapter_url = self.iris_gateway_url(profile)
        if not self.token and not url_is_loopback(adapter_url):
            return {
                "ok": False,
                "profile": profile,
                "current": None,
                "providers": [],
                "generatedAt": int(time.time()),
                "error": f"Iris Desktop remote access uses SSH to a loopback Core. Configure the Hermes adapter with a loopback IRIS_BASE_URL on the Hermes host instead of {adapter_url}.",
            }
        query = urllib.parse.urlencode({"maxModels": max(1, min(int(max_models), 200))})
        url = f"{adapter_url.rstrip('/')}/iris/models?{query}"
        return adapter_catalog_request(url, self.token, profile, fallback_key="providers")

    def slash_commands(self, profile: str) -> dict[str, Any]:
        adapter_url = self.iris_gateway_url(profile)
        if not self.token and not url_is_loopback(adapter_url):
            return {
                "ok": False,
                "profile": profile,
                "commands": [],
                "generatedAt": int(time.time()),
                "error": f"Iris Desktop remote access uses SSH to a loopback Core. Configure the Hermes adapter with a loopback IRIS_BASE_URL on the Hermes host instead of {adapter_url}.",
            }
        url = f"{adapter_url.rstrip('/')}/iris/slash-commands"
        return adapter_catalog_request(url, self.token, profile, fallback_key="commands")

    def slash_complete(self, profile: str, text: str, limit: int = 30) -> dict[str, Any]:
        adapter_url = self.iris_gateway_url(profile)
        if not self.token and not url_is_loopback(adapter_url):
            return {
                "ok": False,
                "items": [],
                "replaceFrom": 0,
                "error": f"Iris Desktop remote access uses SSH to a loopback Core. Configure the Hermes adapter with a loopback IRIS_BASE_URL on the Hermes host instead of {adapter_url}.",
            }
        url = f"{adapter_url.rstrip('/')}/iris/slash-complete"
        result = http_json(url, method="POST", token=self.token, body={"text": text, "limit": limit})
        if not result.get("ok"):
            return {
                "ok": False,
                "items": [],
                "replaceFrom": 0,
                "url": result.get("url") or url,
                "status": result.get("status"),
                "error": result.get("error") or "Iris slash command completion is unavailable.",
            }
        parsed = result.get("json") if isinstance(result.get("json"), dict) else {}
        return {**parsed, "ok": bool(parsed.get("ok", True)), "url": result.get("url") or url, "status": result.get("status")}

    def list_automations(self, profile: str) -> dict[str, Any]:
        del profile
        return self.jobs_request("/api/jobs?include_disabled=true", method="GET")

    def get_automation(self, external_job_id: str) -> dict[str, Any]:
        return self.jobs_request(
            f"/api/jobs/{urllib.parse.quote(external_job_id, safe='')}",
            method="GET",
        )

    def require_store(self) -> HermesStore:
        if self.hermes_store is None:
            self.hermes_store = HermesStore(self.hermes_home)
        return self.hermes_store

    def create_automation(self, automation: dict[str, Any]) -> dict[str, Any]:
        body: dict[str, Any] = {}
        for key in ("name", "schedule", "prompt", "deliver", "repeat"):
            value = automation.get(key)
            if value not in (None, ""):
                body[key] = value
        skills = automation.get("skills")
        if isinstance(skills, list):
            body["skills"] = [str(item) for item in skills if str(item).strip()]
        return self.jobs_request("/api/jobs", method="POST", body=body)

    def update_automation(self, external_job_id: str, updates: dict[str, Any]) -> dict[str, Any]:
        body: dict[str, Any] = {}
        for key in ("name", "schedule", "prompt", "deliver", "repeat"):
            if key == "repeat" and key in updates:
                body[key] = updates.get(key)
                continue
            value = updates.get(key)
            if value not in (None, ""):
                body[key] = value
        return self.jobs_request(
            f"/api/jobs/{urllib.parse.quote(external_job_id, safe='')}",
            method="PATCH",
            body=body,
        )

    def delete_automation(self, external_job_id: str) -> dict[str, Any]:
        return self.jobs_request(
            f"/api/jobs/{urllib.parse.quote(external_job_id, safe='')}",
            method="DELETE",
        )

    def control_automation(self, external_job_id: str, action: str) -> dict[str, Any]:
        return self.jobs_request(
            f"/api/jobs/{urllib.parse.quote(external_job_id, safe='')}/{action}",
            method="POST",
            body={},
        )

    def jobs_request(self, path: str, *, method: str, body: dict[str, Any] | None = None) -> dict[str, Any]:
        url = f"{str(self.connection.get('gatewayUrl') or DEFAULT_GATEWAY_URL).rstrip('/')}{path}"
        result = http_json(url, method=method, token=self.hermes_api_token, body=body)
        if not result.get("ok"):
            return {
                "ok": False,
                "url": result.get("url") or url,
                "status": result.get("status"),
                "error": result.get("error") or "Hermes jobs API request failed.",
            }
        parsed = result.get("json") if isinstance(result.get("json"), dict) else {}
        if parsed.get("ok") is False:
            return {
                **parsed,
                "url": result.get("url") or url,
                "status": result.get("status"),
                "error": parsed.get("error") or "Hermes jobs API request failed.",
            }
        return {**parsed, "ok": True, "url": result.get("url") or url, "status": result.get("status")}

    def iris_gateway_url(self, profile: str) -> str:
        routes = self.connection.get("irisGatewayUrls") if isinstance(self.connection.get("irisGatewayUrls"), dict) else {}
        explicit = routes.get(profile)
        if explicit:
            return str(explicit)
        default_route = str(routes.get("default") or "")
        if profile and profile != "default":
            profile_url = profile_iris_gateway_url(
                self.hermes_home,
                profile,
                default_route or DEFAULT_IRIS_GATEWAY_URL,
                core_store=self.core_store,
                runtime_id=self.runtime_id,
            )
            if profile_url:
                return profile_url
        if default_route:
            return default_route
        gateway_url = str(self.connection.get("gatewayUrl") or DEFAULT_GATEWAY_URL)
        derived = derive_iris_gateway_url(gateway_url)
        return derived or DEFAULT_IRIS_GATEWAY_URL


def default_iris_gateway_port(default_url: str = DEFAULT_IRIS_GATEWAY_URL) -> int:
    parsed = urllib.parse.urlparse(default_url)
    return int(parsed.port or 8766)


def profile_iris_gateway_url(
    hermes_home: Path | str | None,
    profile: str,
    default_url: str,
    *,
    core_store: CoreStore | None = None,
    runtime_id: str = DEFAULT_RUNTIME_ID,
) -> str:
    if not hermes_home or not profile or profile == "default":
        return ""
    parsed = urllib.parse.urlparse(default_url)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname or not parsed.port:
        return ""
    host = parsed.hostname
    if ":" in host and not host.startswith("["):
        host = f"[{host}]"
    if core_store:
        port = core_store.ensure_runtime_profile_port(
            runtime_id=runtime_id,
            runtime_profile=profile,
            default_port=parsed.port,
        )
        return urllib.parse.urlunparse((parsed.scheme, f"{host}:{port}", "", "", "", ""))
    profiles_root = normalize_hermes_home(hermes_home) / "profiles"
    try:
        profile_names = sorted(
            item.name for item in profiles_root.iterdir()
            if item.is_dir()
        )
    except OSError:
        return ""
    if profile not in profile_names:
        return ""
    return urllib.parse.urlunparse(
        (parsed.scheme, f"{host}:{parsed.port + profile_names.index(profile) + 1}", "", "", "", "")
    )


def derive_iris_gateway_url(gateway_url: str) -> str:
    parsed = urllib.parse.urlparse(gateway_url)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname or not parsed.port:
        return ""
    host = parsed.hostname
    if ":" in host and not host.startswith("["):
        host = f"[{host}]"
    return urllib.parse.urlunparse(
        (parsed.scheme, f"{host}:{parsed.port + IRIS_GATEWAY_PORT_OFFSET}", "", "", "", "")
    )


def url_is_loopback(url: str) -> bool:
    parsed = urllib.parse.urlparse(str(url or ""))
    host = (parsed.hostname or "").strip().lower()
    if host in {"localhost", "127.0.0.1", "::1"}:
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


def probe_endpoint(url: str, *, expected_profile: str = "") -> dict[str, Any]:
    request = urllib.request.Request(url, method="GET")
    try:
        with urllib.request.urlopen(request, timeout=2) as response:
            text = response.read(4096).decode("utf-8", errors="replace")
            parsed: dict[str, Any] = {}
            try:
                loaded = json.loads(text) if text else {}
                if isinstance(loaded, dict):
                    parsed = loaded
            except ValueError:
                parsed = {}
            actual_profile = str(parsed.get("profile") or "").strip()
            ok = 200 <= response.status < 500
            payload: dict[str, Any] = {"ok": ok, "url": url, "status": response.status}
            if actual_profile:
                payload["profile"] = actual_profile
            if expected_profile and actual_profile and actual_profile != expected_profile:
                payload.update({
                    "ok": False,
                    "error": f"Iris adapter is for '{actual_profile}', not '{expected_profile}'.",
                })
            return payload
    except urllib.error.HTTPError as exc:
        return {"ok": False, "url": url, "status": exc.code, "error": f"HTTP {exc.code}"}
    except Exception as exc:
        return {"ok": False, "url": url, "error": str(exc)}


def adapter_catalog_request(url: str, token: str, profile: str, *, fallback_key: str) -> dict[str, Any]:
    result = http_json(url, method="GET", token=token)
    empty = [] if fallback_key in {"providers", "commands"} else {}
    if not result.get("ok"):
        return {
            "ok": False,
            "profile": profile,
            fallback_key: empty,
            "generatedAt": int(time.time()),
            "url": result.get("url") or url,
            "status": result.get("status"),
            "error": result.get("error") or "Iris adapter request failed.",
        }
    parsed = result.get("json") if isinstance(result.get("json"), dict) else {}
    return {
        **parsed,
        "ok": bool(parsed.get("ok", True)),
        "profile": str(parsed.get("profile") or profile),
        "url": result.get("url") or url,
        "status": result.get("status"),
    }


def http_json(url: str, *, method: str, token: str, body: dict[str, Any] | None = None) -> dict[str, Any]:
    data = json.dumps(body or {}).encode("utf-8") if body is not None else None
    headers = {
        "Accept": "application/json",
    }
    if token:
        headers["Authorization"] = f"Bearer {token}"
    if body is not None:
        headers["Content-Type"] = "application/json"
    request = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(request, timeout=8) as response:
            text = response.read().decode("utf-8", errors="replace")
            status = response.status
    except urllib.error.HTTPError as exc:
        text = exc.read().decode("utf-8", errors="replace")
        return {"ok": False, "url": url, "status": exc.code, "error": api_error_text(text) or f"HTTP {exc.code}"}
    except Exception as exc:
        return {"ok": False, "url": url, "error": str(exc)}

    try:
        parsed = json.loads(text) if text else {}
    except json.JSONDecodeError as exc:
        return {"ok": False, "url": url, "status": status, "error": f"Invalid JSON: {exc}"}
    if not isinstance(parsed, dict):
        return {"ok": False, "url": url, "status": status, "error": "Expected a JSON object."}
    return {"ok": True, "url": url, "status": status, "json": parsed}


def http_multipart(
    url: str,
    *,
    method: str,
    token: str,
    payload: dict[str, Any],
    files: list[dict[str, Any]],
) -> dict[str, Any]:
    boundary = f"iris-{uuid.uuid4().hex}"
    body = bytearray()

    def add_part(headers: dict[str, str], content: bytes) -> None:
        body.extend(f"--{boundary}\r\n".encode("utf-8"))
        for key, value in headers.items():
            body.extend(f"{key}: {value}\r\n".encode("utf-8"))
        body.extend(b"\r\n")
        body.extend(content)
        body.extend(b"\r\n")

    add_part(
        {
            "Content-Disposition": 'form-data; name="payload"',
            "Content-Type": "application/json; charset=utf-8",
        },
        json.dumps(payload).encode("utf-8"),
    )
    for file_part in files:
        path = Path(str(file_part.get("path") or ""))
        try:
            data = path.read_bytes()
        except OSError as exc:
            return {"ok": False, "url": url, "error": f"Attachment content is unavailable: {exc}"}
        field = str(file_part.get("field") or "file")
        filename = str(file_part.get("name") or path.name or "attachment")
        mime_type = str(file_part.get("mimeType") or "application/octet-stream")
        add_part(
            {
                "Content-Disposition": (
                    f'form-data; name="{quote_header_value(field)}"; '
                    f'filename="{quote_header_value(filename)}"'
                ),
                "Content-Type": mime_type,
            },
            data,
        )
    body.extend(f"--{boundary}--\r\n".encode("utf-8"))

    headers = {
        "Accept": "application/json",
        "Content-Type": f"multipart/form-data; boundary={boundary}",
    }
    if token:
        headers["Authorization"] = f"Bearer {token}"
    request = urllib.request.Request(url, data=bytes(body), headers=headers, method=method)
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            text = response.read().decode("utf-8", errors="replace")
            status = response.status
    except urllib.error.HTTPError as exc:
        text = exc.read().decode("utf-8", errors="replace")
        return {"ok": False, "url": url, "status": exc.code, "error": api_error_text(text) or f"HTTP {exc.code}"}
    except Exception as exc:
        return {"ok": False, "url": url, "error": str(exc)}

    try:
        parsed = json.loads(text) if text else {}
    except json.JSONDecodeError as exc:
        return {"ok": False, "url": url, "status": status, "error": f"Invalid JSON: {exc}"}
    if not isinstance(parsed, dict):
        return {"ok": False, "url": url, "status": status, "error": "Expected a JSON object."}
    return {"ok": True, "url": url, "status": status, "json": parsed}


def quote_header_value(value: str) -> str:
    return value.replace("\\", "\\\\").replace('"', '\\"')


def api_error_text(text: str) -> str:
    try:
        parsed = json.loads(text)
    except json.JSONDecodeError:
        return text.strip()[:240]
    if isinstance(parsed, dict):
        return str(parsed.get("error") or parsed.get("detail") or "").strip()[:240]
    return text.strip()[:240]


def is_transformed_voice_message_content(content: str) -> bool:
    normalized = str(content or "").strip().lower()
    return (
        normalized.startswith("[the user sent a voice message") or
        normalized.startswith("transcription of voice message:")
    )
