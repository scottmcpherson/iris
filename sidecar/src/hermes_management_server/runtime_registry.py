"""Runtime registry for Iris Core."""

from __future__ import annotations

import time
from typing import Any

from .core_store import CoreStore, DEFAULT_RUNTIME_ID
from .hermes_store import HermesStore
from .runtime_adapters.hermes import HermesRuntimeAdapter, local_runtime_config


class RuntimeRegistry:
    def __init__(
        self,
        *,
        core_store: CoreStore,
        hermes_store: HermesStore,
        management_url: str,
        agentui_token: str = "",
        hermes_api_token: str = "",
    ) -> None:
        self.core_store = core_store
        self.hermes_store = hermes_store
        self.management_url = management_url
        self.agentui_token = agentui_token
        self.hermes_api_token = hermes_api_token
        self._last_agent_sync_at = 0.0

    def ensure_default_runtime(self) -> dict[str, Any]:
        runtime = self.core_store.upsert_runtime(local_runtime_config(management_url=self.management_url))
        self.sync_hermes_agents(runtime)
        return runtime

    def sync_hermes_agents(self, runtime: dict[str, Any] | None = None, *, force: bool = False) -> list[dict[str, Any]]:
        runtime = runtime or self.core_store.get_runtime(DEFAULT_RUNTIME_ID) or self.ensure_default_runtime()
        existing_agents = self.core_store.list_agents()
        if existing_agents and not force and time.monotonic() - self._last_agent_sync_at < 10:
            return existing_agents
        profiles = self.hermes_store.profiles()
        self._last_agent_sync_at = time.monotonic()
        return self.core_store.sync_agents_from_profiles(runtime, profiles)

    def runtimes(self) -> list[dict[str, Any]]:
        self.ensure_default_runtime()
        return self.core_store.list_runtimes()

    def runtime(self, runtime_id: str) -> dict[str, Any] | None:
        self.ensure_default_runtime()
        return self.core_store.get_runtime(runtime_id)

    def agents(self) -> list[dict[str, Any]]:
        self.ensure_default_runtime()
        return self.sync_hermes_agents()

    def agent(self, agent_id: str) -> dict[str, Any] | None:
        self.ensure_default_runtime()
        agent = self.core_store.get_agent(agent_id)
        if agent is None:
            self.sync_hermes_agents()
            agent = self.core_store.get_agent(agent_id)
        return agent

    def adapter_for_runtime(self, runtime_id: str) -> HermesRuntimeAdapter:
        runtime = self.runtime(runtime_id)
        if not runtime:
            raise KeyError(runtime_id)
        if runtime["kind"] != "hermes":
            raise ValueError(f"Runtime kind '{runtime['kind']}' is not supported yet.")
        return HermesRuntimeAdapter(
            runtime,
            agentui_token=self.agentui_token,
            hermes_api_token=self.hermes_api_token,
        )

    def probe(self, runtime_id: str, profile: str = "default") -> dict[str, Any]:
        adapter = self.adapter_for_runtime(runtime_id)
        probe = adapter.probe(profile)
        self.core_store.update_runtime_probe(runtime_id, probe)
        return probe
