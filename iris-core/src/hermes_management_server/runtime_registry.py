"""Runtime registry for Iris Core."""

from __future__ import annotations

from typing import Any

from .core_store import CoreStore
from .runtime_adapters.base import RuntimeAdapter
from .runtime_adapters.hermes import HermesRuntimeAdapter, local_runtime_config


class RuntimeRegistry:
    def __init__(
        self,
        *,
        core_store: CoreStore,
        hermes_home: str | None = None,
        management_url: str,
        iris_token: str = "",
        hermes_api_token: str = "",
    ) -> None:
        self.core_store = core_store
        self.hermes_home = hermes_home
        self.management_url = management_url
        self.iris_token = iris_token
        self.hermes_api_token = hermes_api_token

    def ensure_default_runtime(self) -> dict[str, Any]:
        runtime = self.core_store.upsert_runtime(local_runtime_config(management_url=self.management_url))
        return runtime

    def runtimes(self) -> list[dict[str, Any]]:
        self.ensure_default_runtime()
        return self.core_store.list_runtimes()

    def runtime(self, runtime_id: str) -> dict[str, Any] | None:
        self.ensure_default_runtime()
        return self.core_store.get_runtime(runtime_id)

    def agents(self) -> list[dict[str, Any]]:
        self.ensure_default_runtime()
        agents: list[dict[str, Any]] = []
        for runtime in self.core_store.list_runtimes():
            if not runtime.get("enabled", True):
                continue
            agents.extend(self.adapter_for_runtime(runtime["id"]).list_agents())
        return sorted(agents, key=lambda agent: (not agent["isDefault"], agent["displayName"].lower(), agent["id"]))

    def agent(self, agent_id: str) -> dict[str, Any] | None:
        return next((agent for agent in self.agents() if agent["id"] == agent_id), None)

    def adapter_for_runtime(self, runtime_id: str) -> RuntimeAdapter:
        runtime = self.runtime(runtime_id)
        if not runtime:
            raise KeyError(runtime_id)
        if runtime["kind"] != "hermes":
            raise ValueError(f"Runtime kind '{runtime['kind']}' is not supported yet.")
        return HermesRuntimeAdapter(
            runtime,
            hermes_home=self.hermes_home,
            core_store=self.core_store,
            iris_token=self.iris_token,
            hermes_api_token=self.hermes_api_token,
        )

    def probe(self, runtime_id: str, profile: str = "default") -> dict[str, Any]:
        adapter = self.adapter_for_runtime(runtime_id)
        probe = adapter.probe(profile)
        self.core_store.update_runtime_probe(runtime_id, probe)
        return probe
