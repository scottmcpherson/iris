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


class IrisBridgeTests(unittest.TestCase):
    def test_core_request_uses_selected_core_url_without_token_injection(self) -> None:
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

        try:
            result = core_bridge.core_request(
                {
                    "method": "GET",
                    "path": "/health",
                    "connectionId": "ssh_test",
                    "runtime": {
                        "activeConnectionId": "ssh_test",
                        "coreConnections": [
                            {
                                "id": "ssh_test",
                                "mode": "ssh",
                                "effectiveCoreApiUrl": f"http://127.0.0.1:{server.server_port}",
                            }
                        ],
                    },
                }
            )
        finally:
            server.shutdown()
            server.server_close()

        self.assertTrue(result["ok"], result)
        self.assertEqual(result["value"], 3)
        self.assertEqual(seen["path"], "/v1/health")
        self.assertEqual(seen["authorization"], "")

    def test_core_request_supports_put(self) -> None:
        result = core_bridge.core_request({"method": "PUT", "path": ""})
        self.assertFalse(result["ok"])
        self.assertEqual(result["error"], "Core request path is required.")

    def test_webview_audio_transcode_detection_uses_filename(self) -> None:
        self.assertTrue(core_bridge.should_transcode_audio_for_webview("application/octet-stream", "dictation.webm"))
        self.assertTrue(core_bridge.should_transcode_audio_for_webview("audio/ogg", "voice.ogg"))
        self.assertFalse(core_bridge.should_transcode_audio_for_webview("audio/mp4", "voice.m4a"))

    def test_core_attachment_data_returns_data_url_without_token_injection(self) -> None:
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

        try:
            result = core_bridge.core_attachment_data(
                {
                    "path": "/v1/attachments/att_1/content",
                    "connectionId": "ssh_test",
                    "runtime": {
                        "activeConnectionId": "ssh_test",
                        "coreConnections": [
                            {
                                "id": "ssh_test",
                                "mode": "ssh",
                                "effectiveCoreApiUrl": f"http://127.0.0.1:{server.server_port}",
                            }
                        ],
                    },
                }
            )
        finally:
            server.shutdown()
            server.server_close()

        self.assertTrue(result["ok"], result)
        self.assertEqual(result["mimeType"], "audio/mp4")
        self.assertEqual(result["dataUrl"], "data:audio/mp4;base64,YXVkaW8tYnl0ZXM=")
        self.assertEqual(seen["path"], "/v1/attachments/att_1/content")
        self.assertEqual(seen["authorization"], "")

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
