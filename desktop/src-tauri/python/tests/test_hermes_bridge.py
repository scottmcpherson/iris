from __future__ import annotations

import importlib.util
import json
import os
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path


BRIDGE_PATH = Path(__file__).resolve().parents[1] / "hermes_bridge.py"
SPEC = importlib.util.spec_from_file_location("hermes_bridge", BRIDGE_PATH)
assert SPEC and SPEC.loader
hermes_bridge = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(hermes_bridge)


class HermesBridgeTests(unittest.TestCase):
    def test_profile_names_reject_path_traversal(self) -> None:
        with self.assertRaises(ValueError):
            hermes_bridge.safe_profile_name("../bad")

    def test_memory_file_path_is_limited_to_memory_files(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self.assertEqual(
                hermes_bridge.memory_file_path(root, "memory"),
                root / "memories" / "MEMORY.md",
            )
            with self.assertRaises(ValueError):
                hermes_bridge.memory_file_path(root, "../../config.yaml")

    def test_remote_credentials_use_test_store_without_localstorage(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            old_value = os.environ.get("HERMES_DESKTOP_SECRET_TEST_DIR")
            os.environ["HERMES_DESKTOP_SECRET_TEST_DIR"] = directory
            try:
                saved = hermes_bridge.remote_credential_save({"token": "secret-token"})
                self.assertTrue(saved["ok"])
                self.assertEqual(saved["kind"], "hermes")
                self.assertEqual(saved["source"], "test-file")

                status = hermes_bridge.remote_credential_status({})
                self.assertTrue(status["exists"])
                self.assertEqual(status["kind"], "hermes")
                self.assertEqual(hermes_bridge.read_remote_token(), "secret-token")

                sidecar_saved = hermes_bridge.remote_credential_save({"kind": "sidecar", "token": "sidecar-token"})
                self.assertTrue(sidecar_saved["ok"])
                self.assertEqual(hermes_bridge.test_credential_path("sidecar").name, "hermes-sidecar-token")
                self.assertEqual(hermes_bridge.read_remote_token("sidecar"), "sidecar-token")

                deleted = hermes_bridge.remote_credential_delete({})
                self.assertTrue(deleted["ok"])
                self.assertFalse(hermes_bridge.remote_credential_status({})["exists"])
                self.assertTrue(hermes_bridge.remote_credential_status({"kind": "sidecar"})["exists"])
            finally:
                if old_value is None:
                    os.environ.pop("HERMES_DESKTOP_SECRET_TEST_DIR", None)
                else:
                    os.environ["HERMES_DESKTOP_SECRET_TEST_DIR"] = old_value

    def test_management_requests_use_sidecar_token(self) -> None:
        seen_headers: dict[str, str] = {}

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self) -> None:  # noqa: N802
                seen_headers["authorization"] = self.headers.get("Authorization", "")
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps({"ok": True}).encode("utf-8"))

            def log_message(self, _format: str, *args: object) -> None:
                return

        server = HTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()

        with tempfile.TemporaryDirectory() as directory:
            old_value = os.environ.get("HERMES_DESKTOP_SECRET_TEST_DIR")
            os.environ["HERMES_DESKTOP_SECRET_TEST_DIR"] = directory
            try:
                hermes_bridge.remote_credential_save({"kind": "hermes", "token": "hermes-token"})
                hermes_bridge.remote_credential_save({"kind": "sidecar", "token": "sidecar-token"})
                result = hermes_bridge.management_get(
                    {"runtime": {"managementApiUrl": f"http://127.0.0.1:{server.server_port}"}},
                    "/status",
                )
            finally:
                server.shutdown()
                server.server_close()
                if old_value is None:
                    os.environ.pop("HERMES_DESKTOP_SECRET_TEST_DIR", None)
                else:
                    os.environ["HERMES_DESKTOP_SECRET_TEST_DIR"] = old_value

        self.assertTrue(result["ok"], result)
        self.assertEqual(seen_headers["authorization"], "Bearer sidecar-token")

    def test_agentui_inbox_token_can_authorize_sidecar_requests(self) -> None:
        old_value = os.environ.get("AGENTUI_INBOX_TOKEN")
        try:
            os.environ["AGENTUI_INBOX_TOKEN"] = "inbox-token"
            self.assertEqual(hermes_bridge.read_env_token("sidecar"), "inbox-token")
        finally:
            if old_value is None:
                os.environ.pop("AGENTUI_INBOX_TOKEN", None)
            else:
                os.environ["AGENTUI_INBOX_TOKEN"] = old_value

    def test_agentui_gateway_message_uses_profile_derived_adapter_url(self) -> None:
        seen_headers: dict[str, str] = {}
        seen_request: dict[str, object] = {}

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self) -> None:  # noqa: N802
                seen_headers["authorization"] = self.headers.get("Authorization", "")
                seen_request["path"] = self.path
                length = int(self.headers.get("Content-Length", "0"))
                seen_request["body"] = json.loads(self.rfile.read(length).decode("utf-8"))
                self.send_response(202)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps({
                    "ok": True,
                    "accepted": True,
                    "platform": "agentui",
                    "profile": "Health",
                    "chatId": "desktop-1",
                }).encode("utf-8"))

            def log_message(self, _format: str, *args: object) -> None:
                return

        server = HTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        old_token = os.environ.get("AGENTUI_TOKEN")
        try:
            os.environ["AGENTUI_TOKEN"] = "agentui-token"
            api_port = server.server_port - hermes_bridge.AGENTUI_GATEWAY_PORT_OFFSET
            self.assertGreater(api_port, 0)
            result = hermes_bridge.gateway_message({
                "profile": "Health",
                "text": "hello",
                "chatId": "desktop-1",
                "chatName": "Health chat",
                "messageId": "msg-1",
                "runtime": {
                    "profileApiUrls": {
                        "Health": f"http://127.0.0.1:{api_port}",
                    },
                },
            })
        finally:
            server.shutdown()
            server.server_close()
            if old_token is None:
                os.environ.pop("AGENTUI_TOKEN", None)
            else:
                os.environ["AGENTUI_TOKEN"] = old_token

        self.assertTrue(result["ok"], result)
        self.assertEqual(result["profile"], "Health")
        self.assertEqual(seen_request["path"], "/agentui/messages")
        self.assertEqual(seen_headers["authorization"], "Bearer agentui-token")
        self.assertEqual(seen_request["body"]["profile"], "Health")

    def test_agentui_models_use_profile_derived_adapter_url(self) -> None:
        seen_headers: dict[str, str] = {}
        seen_request: dict[str, object] = {}

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self) -> None:  # noqa: N802
                seen_headers["authorization"] = self.headers.get("Authorization", "")
                seen_request["path"] = self.path
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps({
                    "ok": True,
                    "profile": "Health",
                    "current": {
                        "provider": "openai-codex",
                        "model": "gpt-5.5",
                        "provider_name": "OpenAI Codex",
                    },
                    "providers": [
                        {
                            "slug": "openai-codex",
                            "name": "OpenAI Codex",
                            "is_current": True,
                            "is_user_defined": False,
                            "models": ["gpt-5.5", "gpt-5.4"],
                            "total_models": 2,
                            "source": "built-in",
                        },
                    ],
                    "generated_at": 1710000000,
                }).encode("utf-8"))

            def log_message(self, _format: str, *args: object) -> None:
                return

        server = HTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        old_token = os.environ.get("AGENTUI_TOKEN")
        try:
            os.environ["AGENTUI_TOKEN"] = "agentui-token"
            api_port = server.server_port - hermes_bridge.AGENTUI_GATEWAY_PORT_OFFSET
            self.assertGreater(api_port, 0)
            result = hermes_bridge.models({
                "profile": "Health",
                "runtime": {
                    "profileApiUrls": {
                        "Health": f"http://127.0.0.1:{api_port}",
                    },
                },
            })
        finally:
            server.shutdown()
            server.server_close()
            if old_token is None:
                os.environ.pop("AGENTUI_TOKEN", None)
            else:
                os.environ["AGENTUI_TOKEN"] = old_token

        self.assertTrue(result["ok"], result)
        self.assertEqual(seen_request["path"], "/agentui/models?maxModels=100")
        self.assertEqual(seen_headers["authorization"], "Bearer agentui-token")
        self.assertEqual(result["current"]["providerName"], "OpenAI Codex")
        self.assertEqual(result["providers"][0]["isCurrent"], True)
        self.assertEqual(result["providers"][0]["isUserDefined"], False)
        self.assertEqual(result["providers"][0]["totalModels"], 2)

    def test_agentui_models_unavailable_returns_structured_error(self) -> None:
        old_token = os.environ.get("AGENTUI_TOKEN")
        try:
            os.environ["AGENTUI_TOKEN"] = "agentui-token"
            result = hermes_bridge.models({
                "profile": "Health",
                "runtime": {
                    "agentuiGatewayUrls": {
                        "Health": "http://127.0.0.1:9",
                    },
                },
            })
        finally:
            if old_token is None:
                os.environ.pop("AGENTUI_TOKEN", None)
            else:
                os.environ["AGENTUI_TOKEN"] = old_token

        self.assertFalse(result["ok"])
        self.assertEqual(result["profile"], "Health")
        self.assertEqual(result["providers"], [])
        self.assertIn("error", result)

    def test_agentui_slash_commands_use_profile_derived_adapter_url(self) -> None:
        seen_headers: dict[str, str] = {}
        seen_request: dict[str, object] = {}

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self) -> None:  # noqa: N802
                seen_headers["authorization"] = self.headers.get("Authorization", "")
                seen_request["path"] = self.path
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps({
                    "ok": True,
                    "profile": "Health",
                    "generated_at": 1710000000,
                    "commands": [
                        {
                            "id": "hermes:reload-skills",
                            "name": "reload-skills",
                            "text": "/reload-skills",
                            "label": "/reload-skills",
                            "description": "Re-scan skills",
                            "category": "Tools & Skills",
                            "source": "hermes",
                            "aliases": ["reload_skills"],
                            "args_hint": "",
                            "subcommands": [],
                            "requires_argument": False,
                        }
                    ],
                }).encode("utf-8"))

            def log_message(self, _format: str, *args: object) -> None:
                return

        server = HTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        old_token = os.environ.get("AGENTUI_TOKEN")
        try:
            os.environ["AGENTUI_TOKEN"] = "agentui-token"
            api_port = server.server_port - hermes_bridge.AGENTUI_GATEWAY_PORT_OFFSET
            self.assertGreater(api_port, 0)
            result = hermes_bridge.slash_commands({
                "profile": "Health",
                "runtime": {
                    "profileApiUrls": {
                        "Health": f"http://127.0.0.1:{api_port}",
                    },
                },
            })
        finally:
            server.shutdown()
            server.server_close()
            if old_token is None:
                os.environ.pop("AGENTUI_TOKEN", None)
            else:
                os.environ["AGENTUI_TOKEN"] = old_token

        self.assertTrue(result["ok"], result)
        self.assertEqual(seen_request["path"], "/agentui/slash-commands")
        self.assertEqual(seen_headers["authorization"], "Bearer agentui-token")
        self.assertEqual(result["profile"], "Health")
        self.assertEqual(result["generatedAt"], 1710000000)
        self.assertEqual(result["commands"][0]["argsHint"], "")
        self.assertEqual(result["commands"][0]["requiresArgument"], False)

    def test_agentui_slash_complete_posts_text_and_normalizes_items(self) -> None:
        seen_headers: dict[str, str] = {}
        seen_request: dict[str, object] = {}

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self) -> None:  # noqa: N802
                seen_headers["authorization"] = self.headers.get("Authorization", "")
                seen_request["path"] = self.path
                length = int(self.headers.get("Content-Length", "0"))
                seen_request["body"] = json.loads(self.rfile.read(length).decode("utf-8"))
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps({
                    "ok": True,
                    "items": [
                        {"text": "/reload-skills", "display": "/reload-skills", "meta": "Re-scan skills"}
                    ],
                    "replace_from": 1,
                }).encode("utf-8"))

            def log_message(self, _format: str, *args: object) -> None:
                return

        server = HTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        old_token = os.environ.get("AGENTUI_TOKEN")
        try:
            os.environ["AGENTUI_TOKEN"] = "agentui-token"
            api_port = server.server_port - hermes_bridge.AGENTUI_GATEWAY_PORT_OFFSET
            self.assertGreater(api_port, 0)
            result = hermes_bridge.slash_complete({
                "profile": "Health",
                "text": "/re",
                "limit": 10,
                "runtime": {
                    "profileApiUrls": {
                        "Health": f"http://127.0.0.1:{api_port}",
                    },
                },
            })
        finally:
            server.shutdown()
            server.server_close()
            if old_token is None:
                os.environ.pop("AGENTUI_TOKEN", None)
            else:
                os.environ["AGENTUI_TOKEN"] = old_token

        self.assertTrue(result["ok"], result)
        self.assertEqual(seen_request["path"], "/agentui/slash-complete")
        self.assertEqual(seen_headers["authorization"], "Bearer agentui-token")
        self.assertEqual(seen_request["body"], {"text": "/re", "limit": 10})
        self.assertEqual(result["items"][0]["display"], "/reload-skills")
        self.assertEqual(result["replaceFrom"], 1)

    def test_conversations_read_management_api(self) -> None:
        seen: dict[str, str] = {}

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self) -> None:  # noqa: N802
                seen["path"] = self.path
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps({
                    "ok": True,
                    "profile": "Health",
                    "path": "/remote/.hermes/profiles/Health/state.db",
                    "source": "hermes-management",
                    "schemaVersion": 11,
                    "conversations": [
                        {
                            "id": "session-1",
                            "source": "api_server",
                            "model": "gpt-5.5",
                            "title": "A title",
                            "preview": "A preview",
                            "startedAt": 1777804077,
                            "endedAt": None,
                            "lastActiveAt": 1777804079,
                            "messageCount": 2,
                        }
                    ],
                    "warning": None,
                }).encode("utf-8"))

            def log_message(self, _format: str, *args: object) -> None:
                return

        server = HTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            result = hermes_bridge.conversations({
                "profile": "Health",
                "limit": 500,
                "runtime": {
                    "managementApiUrl": f"http://127.0.0.1:{server.server_port}/v1",
                },
            })
        finally:
            server.shutdown()
            server.server_close()

        self.assertTrue(result["ok"])
        self.assertEqual(result["profile"], "Health")
        self.assertEqual(result["source"], "hermes-management")
        self.assertEqual(result["path"], "/remote/.hermes/profiles/Health/state.db")
        self.assertEqual(result["schemaVersion"], 11)
        self.assertEqual(seen["path"], "/v1/profiles/Health/conversations?limit=200")
        self.assertEqual(result["conversations"][0]["id"], "session-1")
        self.assertEqual(result["conversations"][0]["lastActiveAt"], 1777804079.0)

    def test_conversation_detail_reads_management_api(self) -> None:
        seen: dict[str, str] = {}

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self) -> None:  # noqa: N802
                seen["path"] = self.path
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps({
                    "ok": True,
                    "profile": "default",
                    "path": "/remote/.hermes/state.db",
                    "source": "hermes-management",
                    "schemaVersion": 11,
                    "conversation": {
                        "id": "session-1",
                        "source": "api_server",
                        "model": "gpt-5.5",
                        "title": "Hello state",
                        "preview": "Hi from state",
                        "startedAt": 1710000000,
                        "endedAt": None,
                        "lastActiveAt": 1710000002,
                        "messageCount": 2,
                    },
                    "messages": [
                        {
                            "id": "1",
                            "sessionId": "session-1",
                            "role": "user",
                            "content": "Hello state",
                            "toolName": "",
                            "timestamp": 1710000001,
                        },
                        {
                            "id": "2",
                            "sessionId": "session-1",
                            "role": "assistant",
                            "content": "Hi from state",
                            "toolName": "",
                            "toolCalls": [
                                {
                                    "id": "call_1",
                                    "type": "function",
                                    "function": {
                                        "name": "terminal",
                                        "arguments": "{\"command\":\"echo hi\"}",
                                    },
                                }
                            ],
                            "timestamp": 1710000002,
                        },
                    ],
                    "warning": None,
                }).encode("utf-8"))

            def log_message(self, _format: str, *args: object) -> None:
                return

        server = HTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            result = hermes_bridge.conversation_detail({
                "profile": "default",
                "conversationId": "session-1",
                "runtime": {
                    "managementApiUrl": f"http://127.0.0.1:{server.server_port}/v1",
                    "gatewayUrl": "http://127.0.0.1:1/v1",
                },
            })
        finally:
            server.shutdown()
            server.server_close()

        self.assertTrue(result["ok"], result)
        self.assertEqual(seen["path"], "/v1/profiles/default/conversations/session-1")
        self.assertEqual(result["source"], "hermes-management")
        self.assertEqual(result["conversation"]["id"], "session-1")
        self.assertEqual(result["conversation"]["title"], "Hello state")
        self.assertEqual([message["role"] for message in result["messages"]], ["user", "assistant"])
        self.assertEqual(result["messages"][1]["content"], "Hi from state")
        self.assertEqual(result["messages"][1]["toolCalls"][0]["function"]["name"], "terminal")

    def test_profile_sidecar_url_overrides_legacy_management_url(self) -> None:
        result = hermes_bridge.bridge_config({
            "profile": "Health",
            "runtime": {
                "managementApiUrl": "http://127.0.0.1:8765",
                "profileSidecarUrls": {
                    "Health": "http://127.0.0.1:8766",
                },
            },
        })

        self.assertEqual(result["managementApiUrl"], "http://127.0.0.1:8766")

    def test_status_reads_profiles_from_management_api(self) -> None:
        class Handler(BaseHTTPRequestHandler):
            def do_GET(self) -> None:  # noqa: N802
                if self.path == "/health":
                    payload = {"ok": True}
                elif self.path == "/v1/status":
                    payload = {
                        "ok": True,
                        "checkedAt": 1710000000,
                        "hermesHome": "/remote/.hermes",
                        "activeProfile": "Health",
                        "profileCount": 2,
                    }
                elif self.path == "/v1/profiles":
                    payload = {
                        "ok": True,
                        "hermesHome": "/remote/.hermes",
                        "activeProfile": "Health",
                        "profiles": [
                            {
                                "name": "default",
                                "path": "/remote/.hermes",
                                "active": False,
                                "exists": True,
                                "provider": "not configured",
                                "model": "not configured",
                                "memoryBytes": 0,
                                "memoryUpdatedAt": None,
                                "skillCount": 0,
                                "gatewayRunning": False,
                            },
                            {
                                "name": "Health",
                                "path": "/remote/.hermes/profiles/Health",
                                "active": True,
                                "exists": True,
                                "provider": "nous",
                                "model": "hermes-4",
                                "memoryBytes": 42,
                                "memoryUpdatedAt": 1710000001,
                                "skillCount": 3,
                                "gatewayRunning": True,
                            },
                        ],
                    }
                else:
                    self.send_response(404)
                    self.end_headers()
                    return
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps(payload).encode("utf-8"))

            def log_message(self, _format: str, *args: object) -> None:
                return

        server = HTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            result = hermes_bridge.status({
                "profile": "Health",
                "runtime": {
                    "connectionMode": "local",
                    "gatewayUrl": "http://127.0.0.1:1/v1",
                    "managementApiUrl": f"http://127.0.0.1:{server.server_port}/v1",
                    "profileApiUrls": {
                        "Health": f"http://127.0.0.1:{server.server_port}",
                    },
                },
            })
        finally:
            server.shutdown()
            server.server_close()

        self.assertTrue(result["ok"], result)
        self.assertEqual(result["root"], "/remote/.hermes")
        self.assertEqual(result["activeProfile"]["name"], "Health")
        self.assertEqual(result["activeProfile"]["path"], "/remote/.hermes/profiles/Health")
        self.assertEqual(result["profiles"][1]["skillCount"], 3)
        self.assertTrue(result["managementStatus"]["ok"])
        self.assertTrue(result["activeApiStatus"]["ok"])
        self.assertEqual(result["activeApiStatus"]["url"], f"http://127.0.0.1:{server.server_port}")

    def test_memory_reads_management_api(self) -> None:
        class Handler(BaseHTTPRequestHandler):
            def do_GET(self) -> None:  # noqa: N802
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps({
                    "ok": True,
                    "profile": "Health",
                    "path": "/remote/.hermes/profiles/Health/memories",
                    "files": [],
                    "memory": {
                        "name": "MEMORY.md",
                        "path": "/remote/.hermes/profiles/Health/memories/MEMORY.md",
                        "exists": True,
                        "updatedAt": 1710000000,
                        "bytes": 13,
                        "content": "remote memory",
                    },
                    "user": {
                        "name": "USER.md",
                        "path": "/remote/.hermes/profiles/Health/memories/USER.md",
                        "exists": False,
                        "updatedAt": None,
                        "bytes": 0,
                        "content": "",
                    },
                }).encode("utf-8"))

            def log_message(self, _format: str, *args: object) -> None:
                return

        server = HTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            result = hermes_bridge.memory({
                "profile": "Health",
                "runtime": {
                    "managementApiUrl": f"http://127.0.0.1:{server.server_port}/v1",
                },
            })
        finally:
            server.shutdown()
            server.server_close()

        self.assertTrue(result["ok"], result)
        self.assertEqual(result["path"], "/remote/.hermes/profiles/Health/memories")
        self.assertEqual(result["memory"]["content"], "remote memory")
        self.assertEqual(result["history"], [])

    def test_profile_actions_use_management_api(self) -> None:
        seen: list[tuple[str, str, dict[str, object]]] = []

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self) -> None:  # noqa: N802
                body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", "0"))))
                seen.append(("POST", self.path, body))
                payload = {
                    "ok": True,
                    "profile": body.get("name"),
                    "profiles": [],
                }
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps(payload).encode("utf-8"))

            def do_DELETE(self) -> None:  # noqa: N802
                seen.append(("DELETE", self.path, {}))
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps({"ok": True, "profile": "default", "profiles": []}).encode("utf-8"))

            def log_message(self, _format: str, *args: object) -> None:
                return

        server = HTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        runtime = {"managementApiUrl": f"http://127.0.0.1:{server.server_port}/v1"}
        try:
            created = hermes_bridge.profile_create({"name": "Research", "runtime": runtime})
            cloned = hermes_bridge.profile_clone({"source": "Health", "name": "Health-copy", "runtime": runtime})
            deleted = hermes_bridge.profile_delete({"name": "Health-copy", "runtime": runtime})
        finally:
            server.shutdown()
            server.server_close()

        self.assertTrue(created["ok"], created)
        self.assertTrue(cloned["ok"], cloned)
        self.assertTrue(deleted["ok"], deleted)
        self.assertEqual(seen[0], ("POST", "/v1/profiles", {"name": "Research"}))
        self.assertEqual(seen[1], ("POST", "/v1/profiles/Health/clone", {"name": "Health-copy"}))
        self.assertEqual(seen[2], ("DELETE", "/v1/profiles/Health-copy", {}))

    def test_skills_and_detail_read_management_api(self) -> None:
        class Handler(BaseHTTPRequestHandler):
            def do_GET(self) -> None:  # noqa: N802
                if self.path == "/v1/profiles/Health/skills":
                    payload = {
                        "ok": True,
                        "profile": "Health",
                        "path": "/remote/.hermes/profiles/Health/skills",
                        "skills": [
                            {
                                "id": "cGVyc29uYWwvZm9vL1NLSUxMLm1k",
                                "name": "Foo",
                                "path": "/remote/.hermes/profiles/Health/skills/personal/foo/SKILL.md",
                                "category": "personal",
                                "description": "Foo skill",
                                "updatedAt": 1710000000,
                                "source": "installed",
                                "version": "0.1.0",
                                "tags": ["foo"],
                                "bytes": 9,
                                "metadata": {"name": "Foo"},
                            }
                        ],
                    }
                elif self.path == "/v1/profiles/Health/skills/cGVyc29uYWwvZm9vL1NLSUxMLm1k":
                    payload = {
                        "ok": True,
                        "profile": "Health",
                        "id": "cGVyc29uYWwvZm9vL1NLSUxMLm1k",
                        "name": "Foo",
                        "path": "/remote/.hermes/profiles/Health/skills/personal/foo/SKILL.md",
                        "category": "personal",
                        "description": "Foo skill",
                        "updatedAt": 1710000000,
                        "source": "installed",
                        "version": "0.1.0",
                        "tags": ["foo"],
                        "bytes": 9,
                        "metadata": {"name": "Foo"},
                        "content": "# Foo",
                    }
                else:
                    self.send_response(404)
                    self.end_headers()
                    return
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps(payload).encode("utf-8"))

            def log_message(self, _format: str, *args: object) -> None:
                return

        server = HTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        runtime = {"managementApiUrl": f"http://127.0.0.1:{server.server_port}/v1"}
        try:
            skills = hermes_bridge.skills({"profile": "Health", "runtime": runtime})
            detail = hermes_bridge.skill_detail({
                "profile": "Health",
                "skillId": "cGVyc29uYWwvZm9vL1NLSUxMLm1k",
                "runtime": runtime,
            })
        finally:
            server.shutdown()
            server.server_close()

        self.assertTrue(skills["ok"], skills)
        self.assertEqual(skills["skills"][0]["id"], "cGVyc29uYWwvZm9vL1NLSUxMLm1k")
        self.assertTrue(detail["ok"], detail)
        self.assertEqual(detail["content"], "# Foo")
        self.assertEqual(detail["history"], [])

class patched_env:
    def __init__(self, key: str, value: str):
        self.key = key
        self.value = value
        self.old_value = os.environ.get(key)

    def __enter__(self) -> None:
        os.environ[self.key] = self.value

    def __exit__(self, *_exc: object) -> None:
        if self.old_value is None:
            os.environ.pop(self.key, None)
        else:
            os.environ[self.key] = self.old_value

if __name__ == "__main__":
    unittest.main()
