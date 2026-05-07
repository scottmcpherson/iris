# Universal Chat Attachments

## Goal

Allow the chat composer to attach and send any normal user file type, not only image-like attachments. The finished feature should support images, documents, audio, video, archives, source files, and unknown binary files through the same chat message creation flow.

Attachments should be copied into Iris Core storage before message delivery, shown in the composer and message history with type-appropriate affordances, and delivered to the runtime as metadata plus a local Core-managed file path. Hermes remains a runtime backend; attachment ownership and storage stay in Iris Core.

## Current Behavior

The chat UI already has several pieces of a general attachment flow:

- `desktop/src/features/chat/ChatView.tsx` owns the composer file input, drag/drop handling, local `AttachmentDraft` state, and native Tauri path drops.
- `desktop/src/features/chat/components/AttachmentTray.tsx` shows pending attachments in the composer.
- `desktop/src/features/chat/components/MessageContent.tsx` renders sent attachments above message content.
- `desktop/src/features/chat/chatAttachments.ts` uploads draft attachments through `uploadAgentUICoreAttachment()` and formats the text prompt with an `Attached files:` summary.
- `desktop/src/lib/agentuiCore.ts` posts browser `File` uploads directly to `POST /v1/attachments` and uses the Tauri `core_upload_path` bridge for native local paths.
- `desktop/src-tauri/python/core_bridge.py` handles native path upload by reading the local file and posting multipart form data to Core.
- `sidecar/src/hermes_management_server/main.py` exposes `POST /v1/attachments`, `/content`, and `/preview`.
- `sidecar/src/hermes_management_server/core_store.py` owns attachment persistence under `~/.iris/attachments` and links attachments to messages.

The limiting behavior is mostly server-side:

- `sidecar/src/hermes_management_server/core_store.py` has `ALLOWED_ATTACHMENT_MIME_TYPES` limited to PNG, JPEG, WebP, GIF, PDF, plain text, and Markdown.
- `MessageAttachment.kind` and `AgentUICoreAttachment.kind` are only `"image" | "file"`, so documents, audio, video, archives, and code all render as generic files.
- `attachment_mime_type()` in `sidecar/src/hermes_management_server/main.py` only sniffs a few image/PDF signatures and otherwise trusts `mimetypes` or the browser content type.
- `desktop/src/shared/files.ts` only recognizes image extensions, so native path drops often lose useful MIME/type information for documents, audio, and video.
- `/v1/attachments/{id}/preview` only supports image previews. That is fine, but the client currently treats `previewUrl` as a mostly image-specific concept rather than modeling media-specific display.
- The current 25 MB limit in `MAX_ATTACHMENT_SIZE_BYTES` and `core_upload_path()` is too small for many ordinary videos and some audio/document uploads.

## Non-Goals

- Do not execute, render active HTML, or run scripts from uploaded attachments.
- Do not edit Hermes under `~/.hermes` to make this work.
- Do not make Hermes the storage owner for attachments.
- Do not build document parsing, transcription, OCR, or video frame extraction in this pass.
- Do not promise that every model/runtime can semantically understand every attachment. The first implementation guarantees upload, storage, history display, download, and runtime delivery of file references.

## Product Requirements

- The paperclip/add-context flow accepts all file categories from the system picker.
- Drag/drop accepts the same categories, including native Tauri path drops.
- A message can be sent with only attachments and no typed text.
- Composer chips show a recognizable icon for image, document, audio, video, archive, code/text, and unknown files.
- Images can still show thumbnails.
- Audio and video attachments should show media-specific icons and metadata, not broken image thumbnails.
- Sent message attachments should be clickable or otherwise open/downloadable through the existing Core content URL.
- Upload failures should name the file and explain the limit or unsupported condition.
- Empty files should still be rejected.
- Per-message attachment count should remain capped initially unless product decides otherwise; current cap is 8.
- File size limits should be explicit in UI and errors. Raise the default limit above 25 MB if video support is part of this release.

## Attachment Contract

Extend the shared attachment kind from the current two-value shape:

```ts
kind: "image" | "file"
```

to:

```ts
kind: "image" | "document" | "audio" | "video" | "archive" | "code" | "file"
```

Use this as a display and routing hint, not a security boundary. The source of truth for bytes remains the stored blob and normalized MIME type.

Update these type definitions:

- `desktop/src/app/types.ts`
- `desktop/src/lib/agentuiCore.ts`
- `desktop/src/features/chat/chatTypes.ts`
- `sidecar/src/hermes_management_server/models.py` if the Pydantic request/response models encode attachment shape.
- Any sidecar tests that assert `kind` is only image or file.

Response payloads from Core should include:

```json
{
  "id": "att_...",
  "name": "Quarterly Plan.mov",
  "kind": "video",
  "mimeType": "video/quicktime",
  "size": 73400320,
  "sha256": "...",
  "previewUrl": "",
  "downloadUrl": "/v1/attachments/att_.../content"
}
```

For images, Core can keep returning `previewUrl`. For non-images, either omit `previewUrl` or return an empty string until richer previews exist.

## MIME And Kind Detection

Create a single shared classification concept on both client and server.

Client-side helpers should live in `desktop/src/shared/files.ts`:

- `mimeTypeFromPath(path: string): string`
- `attachmentKindFromMime(mimeType: string, filename?: string): MessageAttachment["kind"]`
- `attachmentKindFromPath(path: string): MessageAttachment["kind"]`
- `isPreviewableImage(mimeType: string, filename?: string): boolean`
- `attachmentTypeLabel(kind, mimeType): string`

Server-side helpers should live near the existing upload helpers in `sidecar/src/hermes_management_server/main.py` or move into an attachment module if the file gets too large:

- `attachment_mime_type(filename, content_type, head)`
- `attachment_kind(mime_type, filename, hint)`
- `is_allowed_attachment_mime(mime_type)`

Minimum categories:

- Images: `image/*`, including PNG, JPEG, GIF, WebP, HEIC/HEIF, AVIF, SVG.
- Documents: PDF, Word, Excel, PowerPoint, OpenDocument, RTF, CSV, JSON, XML, HTML, EPUB.
- Text/code: `text/*`, common source file extensions, Markdown, YAML, TOML.
- Audio: `audio/*`, including MP3, WAV, M4A, AAC, OGG, FLAC.
- Video: `video/*`, including MP4, MOV/QuickTime, WebM, MPEG.
- Archives: ZIP, TAR, GZIP, 7z, RAR.
- Unknown: `application/octet-stream` should be accepted and classified as `"file"`.

The server should not rely only on browser-provided MIME. It should prefer lightweight magic-byte sniffing for common formats, then fall back to `mimetypes.guess_type(filename)`, then `content_type`, then `application/octet-stream`.

## Backend Implementation

### 1. Replace The Narrow MIME Allowlist

In `sidecar/src/hermes_management_server/core_store.py`, replace `ALLOWED_ATTACHMENT_MIME_TYPES` with either:

- a broad category allow rule that accepts `image/*`, `audio/*`, `video/*`, `text/*`, and selected `application/*` document/archive formats, plus `application/octet-stream`; or
- a denylist that blocks only known dangerous executable/script launcher formats while still accepting ordinary user files.

Given the user requirement, the broad category allow rule is safer than trying to enumerate every document/audio/video MIME by hand. Keep server-side size and empty-file checks.

### 2. Raise Or Configure Size Limits

Current limit:

- `sidecar/src/hermes_management_server/core_store.py`: `MAX_ATTACHMENT_SIZE_BYTES = 25 * 1024 * 1024`
- `desktop/src-tauri/python/core_bridge.py`: native path upload rejects files over 25 MB.

For video support, make this configurable and use a higher default. A practical first value is 250 MB:

- `IRIS_MAX_ATTACHMENT_SIZE_MB`, default `250`.
- Core and the Python bridge must use the same configured value.
- Surface the limit in upload errors.

If the bridge cannot read Core config directly, duplicate the default but allow `IRIS_MAX_ATTACHMENT_SIZE_MB` in both places.

### 3. Store Every Attachment The Same Way

Keep the existing content-addressed blob storage:

- `~/.iris/attachments/blobs/{sha256_prefix}/{sha256}`
- `attachments` table metadata row
- `message_attachments` table link row

Do not add separate storage paths for videos/audio/documents unless there is a real later need.

### 4. Preserve Runtime Delivery

`sidecar/src/hermes_management_server/runtime_adapters/hermes.py` already uses `text_with_runtime_attachments()` to append runtime file paths to message text and metadata. Keep this pattern, but make labels more informative:

```text
Attached files:
1. Quarterly Plan.mov (video/quicktime, 70 MB)
   Runtime path: /Users/scott/.iris/attachments/blobs/...
```

The runtime metadata should include the richer `kind`, MIME type, size, sha256, and local path. The client-facing metadata should not expose internal runtime paths.

### 5. Content And Preview Endpoints

Keep:

- `GET /v1/attachments/{attachment_id}/content` for all attachment kinds.
- `GET /v1/attachments/{attachment_id}/preview` for image attachments only.

Return `415` for non-image previews as today, but the client should stop requesting previews for non-images.

## Desktop Implementation

### 1. Update File Classification

In `desktop/src/shared/files.ts`, expand MIME detection beyond images. This is especially important for native Tauri path drops, where there is no browser `File.type`.

Use extension maps for common document/audio/video/archive/code types, and use those helpers from:

- `desktop/src/features/chat/ChatView.tsx` in `addFiles()` and `addPaths()`.
- `desktop/src/features/chat/components/AttachmentTray.tsx` for labels/icons.
- `desktop/src/features/chat/components/MessageContent.tsx` for sent attachment cards.

### 2. Make The File Picker Clearly Universal

The existing `<input type="file" multiple>` has no `accept` attribute, which is good. Keep it unrestricted.

Rename visible copy where needed:

- Menu item can stay `Add photos & files`, but `Add files` is clearer.
- Drop overlay should say `Drop files to add them`.

Do not add an `accept="image/*"` attribute.

### 3. Add Type-Aware Icons

Use `lucide-react` icons in the existing components:

- `Image` for images without a thumbnail.
- `FileText` for documents/text/code.
- `Music` or `AudioLines` for audio.
- `Video` for video.
- `Archive` for archives.
- `Paperclip` for unknown files.

Affected files:

- `desktop/src/features/chat/components/AttachmentTray.tsx`
- `desktop/src/features/chat/components/MessageContent.tsx`

Keep the current compact chip/card layout. Do not introduce a separate upload panel.

### 4. Make Attachments Openable

In `MessageAttachments`, wrap each sent attachment card in a button or anchor that opens `downloadUrl`/content URL through `openUrl()`.

Rules:

- Images can still display a thumbnail and open the content URL.
- Non-images show an icon and open/download the content URL.
- Legacy local-path attachments can use `convertFileSrc()` only for previewable images; otherwise show the icon and avoid pretending there is a Core download.

### 5. Improve Error State

`useAgentUIChat.sendMessage()` currently catches upload failures and restores input, but it does not expose the upload error to the composer. Add a path for `ChatView` to retain per-attachment `uploadStatus: "error"` and `uploadError`, or surface a notification through the existing app notification path.

Preferred first pass:

- `uploadAttachmentsForSend()` throws an error containing the failing filename.
- `sendMessage()` returns `false` and the UI leaves attachments in the tray.
- `ChatView` marks the failed attachment with a concise error if the failing id/name is available.

## Tests

### Desktop Unit Tests

Add tests for classification helpers in `desktop/src/shared/files.ts`:

- PNG/JPEG/GIF/WebP/HEIC/AVIF/SVG => image.
- PDF/DOCX/XLSX/PPTX/CSV/RTF/EPUB => document.
- MP3/WAV/M4A/FLAC => audio.
- MP4/MOV/WebM => video.
- ZIP/TAR/GZ/7Z => archive.
- TS/JS/PY/RB/GO/RS/YAML/TOML => code.
- Unknown extension => file with `application/octet-stream` fallback.

Update `desktop/src/lib/__tests__/agentuiCore.test.ts`:

- Existing image upload still passes `kind=image`.
- Add PDF or DOCX upload passing `kind=document`.
- Add MP4 upload passing `kind=video`.
- Add unknown binary upload passing `kind=file`.

### Sidecar Tests

Update `sidecar/tests/test_api.py` and `sidecar/tests/test_core_store.py`:

- Upload PDF succeeds and returns `kind=document`.
- Upload MP3 succeeds and returns `kind=audio`.
- Upload MP4/MOV succeeds and returns `kind=video`.
- Upload ZIP succeeds and returns `kind=archive`.
- Unknown `application/octet-stream` succeeds and returns `kind=file`.
- Empty file still returns `400`.
- Oversized file returns `413` with the configured limit in the error.
- Non-image `/preview` still returns `415`.
- `/content` returns the stored bytes and correct media type for non-images.
- Message send persists non-image attachments in client metadata and runtime metadata.

### Runtime Adapter Tests

Extend the existing attachment send test around `test_core_send_persists_top_level_attachments_as_message_metadata`:

- Use a non-image file.
- Assert the runtime metadata includes `kind`, MIME, size, sha256, and `runtime.path`.
- Assert the user-visible persisted attachment does not expose `runtime.path`.
- Assert the runtime text summary includes the attachment name and MIME type.

## Verification

Run:

```sh
npm --workspace desktop run check
npm run sidecar:test
npm run build:mac:app
```

For final feature verification, follow the repo instruction in `AGENTS.md`:

1. Build a fresh macOS bundle with `npm run build:mac:app`.
2. Launch the newly built app bundle.
3. Use the Computer Use plugin against `com.nousresearch.hermes-agent.desktop`.
4. Create a chat message with at least:
   - one image,
   - one document,
   - one audio file,
   - one video file,
   - one unknown or archive file.
5. Confirm each attachment remains visible after send.
6. Confirm images show thumbnails, non-images show correct icons, and content links open/download from Core.
7. Confirm the sidecar database metadata has the expected `kind` and MIME values.
8. Confirm Hermes receives runtime attachment metadata with local Core-managed paths.

Browser/Vite checks are fine during iteration, but final visible UI verification must use the fresh Tauri app bundle plus Computer Use.

## Suggested Implementation Order

1. Add attachment kind/type helpers in `desktop/src/shared/files.ts` and tests.
2. Add matching server-side classification helpers and tests.
3. Replace the narrow `ALLOWED_ATTACHMENT_MIME_TYPES` check with broad attachment acceptance.
4. Make attachment size limit configurable and align Core plus Python bridge behavior.
5. Update TypeScript and Core response types for richer attachment kinds.
6. Update `ChatView` draft creation for browser files and native path drops.
7. Update `AttachmentTray` and `MessageAttachments` to use type-aware icons and open/download behavior.
8. Improve upload error surfacing so failed files stay visible.
9. Extend Core upload and send tests for document/audio/video/archive/unknown files.
10. Run the full verification flow, including fresh Tauri app build and Computer Use.

## Acceptance Criteria

- The composer accepts arbitrary normal files from picker and drag/drop.
- Documents, audio, video, archives, and unknown files upload successfully instead of being rejected by Core MIME allowlist.
- Sent messages persist and re-render non-image attachments after refresh.
- Runtime delivery includes attachment metadata and Core-managed local paths.
- Non-image attachments never try to render through the image preview endpoint.
- The app gives a clear error for empty or oversized files.
- Final validation uses `npm run build:mac:app` and the newly built macOS app bundle.
