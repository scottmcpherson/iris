from hermes_management_server.attachment_types import (
    attachment_kind,
    attachment_mime_type,
    is_allowed_attachment_mime,
    normalize_attachment_mime_type,
    normalized_runtime_mime_type,
)


def test_normalize_attachment_mime_type_strips_parameters_and_aliases_jpeg():
    assert normalize_attachment_mime_type(" Image/JPG ; charset=utf-8 ") == "image/jpeg"
    assert normalize_attachment_mime_type("") == "application/octet-stream"


def test_attachment_mime_type_prefers_sniffed_bytes_over_claimed_content_type():
    assert attachment_mime_type(
        filename="not-really.txt",
        content_type="text/plain",
        head=b"%PDF-1.7\n",
    ) == "application/pdf"


def test_attachment_kind_uses_mime_first_then_filename_extension():
    assert attachment_kind("application/pdf", "unknown.bin") == "document"
    assert attachment_kind("application/octet-stream", "script.ts") == "code"
    assert attachment_kind("application/octet-stream", "clip.webm") == "video"


def test_runtime_mime_type_normalizes_audio_webm_recordings():
    assert normalized_runtime_mime_type({
        "name": "dictation.webm",
        "kind": "audio",
        "mimeType": "video/webm",
    }) == "audio/webm"
    assert normalized_runtime_mime_type({
        "name": "dictation.webm",
        "kind": "audio",
        "mimeType": "application/octet-stream",
    }) == "audio/webm"


def test_allowed_attachment_mime_stays_permissive_for_generic_files():
    assert is_allowed_attachment_mime("application/octet-stream")
    assert is_allowed_attachment_mime("application/zip")
    assert is_allowed_attachment_mime("text/typescript")
