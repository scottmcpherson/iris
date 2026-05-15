from __future__ import annotations

import importlib.util
import json
import os
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path


BRIDGE_PATH = Path(__file__).resolve().parents[1] / "core_bridge.py"
SPEC = importlib.util.spec_from_file_location("core_bridge", BRIDGE_PATH)
assert SPEC and SPEC.loader
core_bridge = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(core_bridge)


def restore_env(values: dict[str, str | None]) -> None:
    for key, value in values.items():
        if value is None:
            os.environ.pop(key, None)
        else:
            os.environ[key] = value


class IrisBridgeTests(unittest.TestCase):
    def test_remote_credentials_use_core_test_store(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            old_value = os.environ.get("IRIS_DESKTOP_SECRET_TEST_DIR")
            os.environ["IRIS_DESKTOP_SECRET_TEST_DIR"] = directory
            try:
                saved = core_bridge.remote_credential_save({"kind": "core", "token": "secret-token"})
                self.assertTrue(saved["ok"])
                self.assertEqual(saved["kind"], "core")
                self.assertEqual(saved["source"], "test-file")
                self.assertEqual(core_bridge.test_credential_path("core").name, "iris-core-token")

                status = core_bridge.remote_credential_status({"kind": "core"})
                self.assertTrue(status["exists"])
                self.assertEqual(status["kind"], "core")
                self.assertEqual(core_bridge.read_remote_token("core"), "secret-token")

                deleted = core_bridge.remote_credential_delete({"kind": "core"})
                self.assertTrue(deleted["ok"])
                self.assertFalse(core_bridge.remote_credential_status({"kind": "core"})["exists"])
            finally:
                if old_value is None:
                    os.environ.pop("IRIS_DESKTOP_SECRET_TEST_DIR", None)
                else:
                    os.environ["IRIS_DESKTOP_SECRET_TEST_DIR"] = old_value

    def test_read_env_token_uses_iris_token(self) -> None:
        removed_token_name = "AGENT" + "UI_TOKEN"
        removed_core_token_name = "IRIS_" + "CORE_TOKEN"
        old_values = {
            "IRIS_TOKEN": os.environ.get("IRIS_TOKEN"),
            removed_core_token_name: os.environ.get(removed_core_token_name),
            removed_token_name: os.environ.get(removed_token_name),
        }
        os.environ["IRIS_TOKEN"] = "iris-env-token"
        os.environ[removed_core_token_name] = "legacy-core-token"
        os.environ[removed_token_name] = "legacy-agent-token"
        try:
            self.assertEqual(core_bridge.read_env_token("core"), "iris-env-token")
            self.assertEqual(core_bridge.read_remote_token("core"), "iris-env-token")
        finally:
            restore_env(old_values)

    def test_read_env_token_ignores_legacy_token_names(self) -> None:
        removed_token_name = "AGENT" + "UI_TOKEN"
        removed_core_token_name = "IRIS_" + "CORE_TOKEN"
        old_values = {
            "IRIS_TOKEN": os.environ.get("IRIS_TOKEN"),
            removed_core_token_name: os.environ.get(removed_core_token_name),
            removed_token_name: os.environ.get(removed_token_name),
        }
        os.environ.pop("IRIS_TOKEN", None)
        os.environ[removed_core_token_name] = "legacy-core-token"
        os.environ[removed_token_name] = "legacy-agent-token"
        try:
            self.assertEqual(core_bridge.read_env_token("core"), "")
        finally:
            restore_env(old_values)

    def test_core_request_uses_core_url_and_token(self) -> None:
        seen: dict[str, str] = {}

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self) -> None:  # noqa: N802
                seen["path"] = self.path
                seen["authorization"] = self.headers.get("Authorization", "")
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps({"ok": True, "value": 3}).encode("utf-8"))

            def log_message(self, _format: str, *args: object) -> None:
                return

        server = HTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()

        with tempfile.TemporaryDirectory() as directory:
            old_value = os.environ.get("IRIS_DESKTOP_SECRET_TEST_DIR")
            os.environ["IRIS_DESKTOP_SECRET_TEST_DIR"] = directory
            try:
                core_bridge.remote_credential_save({"kind": "core", "token": "core-token"})
                result = core_bridge.core_request(
                    {
                        "method": "GET",
                        "path": "/health",
                        "runtime": {"coreApiUrl": f"http://127.0.0.1:{server.server_port}"},
                    }
                )
            finally:
                server.shutdown()
                server.server_close()
                if old_value is None:
                    os.environ.pop("IRIS_DESKTOP_SECRET_TEST_DIR", None)
                else:
                    os.environ["IRIS_DESKTOP_SECRET_TEST_DIR"] = old_value

        self.assertTrue(result["ok"], result)
        self.assertEqual(result["value"], 3)
        self.assertEqual(seen["path"], "/v1/health")
        self.assertEqual(seen["authorization"], "Bearer core-token")

    def test_core_request_supports_put(self) -> None:
        result = core_bridge.core_request({"method": "PUT", "path": ""})
        self.assertFalse(result["ok"])
        self.assertEqual(result["error"], "Core request path is required.")

    def test_webview_audio_transcode_detection_uses_filename(self) -> None:
        self.assertTrue(core_bridge.should_transcode_audio_for_webview("application/octet-stream", "dictation.webm"))
        self.assertTrue(core_bridge.should_transcode_audio_for_webview("audio/ogg", "voice.ogg"))
        self.assertFalse(core_bridge.should_transcode_audio_for_webview("audio/mp4", "voice.m4a"))

    def test_core_attachment_data_returns_authenticated_data_url(self) -> None:
        seen: dict[str, str] = {}

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self) -> None:  # noqa: N802
                seen["path"] = self.path
                seen["authorization"] = self.headers.get("Authorization", "")
                self.send_response(200)
                self.send_header("Content-Type", "audio/mp4")
                self.end_headers()
                self.wfile.write(b"audio-bytes")

            def log_message(self, _format: str, *args: object) -> None:
                return

        server = HTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()

        with tempfile.TemporaryDirectory() as directory:
            old_value = os.environ.get("IRIS_DESKTOP_SECRET_TEST_DIR")
            os.environ["IRIS_DESKTOP_SECRET_TEST_DIR"] = directory
            try:
                core_bridge.remote_credential_save({"kind": "core", "token": "core-token"})
                result = core_bridge.core_attachment_data(
                    {
                        "path": "/v1/attachments/att_1/content",
                        "runtime": {"coreApiUrl": f"http://127.0.0.1:{server.server_port}"},
                    }
                )
            finally:
                server.shutdown()
                server.server_close()
                if old_value is None:
                    os.environ.pop("IRIS_DESKTOP_SECRET_TEST_DIR", None)
                else:
                    os.environ["IRIS_DESKTOP_SECRET_TEST_DIR"] = old_value

        self.assertTrue(result["ok"], result)
        self.assertEqual(result["mimeType"], "audio/mp4")
        self.assertEqual(result["dataUrl"], "data:audio/mp4;base64,YXVkaW8tYnl0ZXM=")
        self.assertEqual(seen["path"], "/v1/attachments/att_1/content")
        self.assertEqual(seen["authorization"], "Bearer core-token")

    def test_core_upload_path_uses_configured_size_limit(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "large.bin"
            path.write_bytes(b"x" * (1024 * 1024 + 1))
            old_value = os.environ.get("IRIS_MAX_ATTACHMENT_SIZE_MB")
            os.environ["IRIS_MAX_ATTACHMENT_SIZE_MB"] = "1"
            try:
                result = core_bridge.core_upload_path({"localPath": str(path), "profile": "default"})
            finally:
                if old_value is None:
                    os.environ.pop("IRIS_MAX_ATTACHMENT_SIZE_MB", None)
                else:
                    os.environ["IRIS_MAX_ATTACHMENT_SIZE_MB"] = old_value

        self.assertFalse(result["ok"])
        self.assertEqual(result["error"], "Attachment exceeds the 1 MB limit.")


if __name__ == "__main__":
    unittest.main()
