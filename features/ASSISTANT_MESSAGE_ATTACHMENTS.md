# Assistant Message Attachments

## Goal

When an agent creates an image, audio file, video, archive, PDF, source file, or any other generated file, the chat should show that output as an accessible message attachment instead of plain text like:

```text
MEDIA:/tmp/red_hue_relief.png
```

Assistant-generated files should use the same visible attachment cards, thumbnails, type labels, and open/download behavior as user-sent files. Iris Core should own the stored attachment copy and content URL; Hermes remains the runtime that generated the file.

## Current Behavior

User message attachments now mostly have the right path:

- `desktop/src/features/chat/ChatView.tsx` creates attachment drafts from browser files and Tauri path drops.
- `desktop/src/features/chat/chatAttachments.ts` uploads drafts through `uploadAgentUICoreAttachment()`.
- `sidecar/src/hermes_management_server/main.py` stores uploads through `POST /v1/attachments`.
- `sidecar/src/hermes_management_server/core_store.py` stores blobs under `~/.iris/attachments` and returns `/content` and image `/preview` URLs.
- `desktop/src/features/chat/components/MessageContent.tsx` renders `message.attachments` with shared cards.

Assistant outputs are still mostly text:

- `desktop/src/features/chat/chatStreamMerging.ts` recognizes post-stream media deliveries such as `Image: ...`, `File: ...`, and `Media: ...`, but only appends that content onto the assistant message body.
- `desktop/src/features/chat/chatHistory.ts` only extracts `metadata.attachments` when `message.role === "user"`.
- `sidecar/src/hermes_management_server/runtime_adapters/hermes.py` overlays Iris client metadata only for user messages in `with_client_message_metadata()`.
- `sidecar/src/hermes_management_server/main.py` publishes runtime delivery events with content and metadata, but it does not import local file paths from assistant deliveries into Core attachment storage.

The result is visible in the screenshot: the agent can create `/tmp/red_hue_relief.png`, but the UI only renders the literal `MEDIA:/tmp/red_hue_relief.png` line. The user cannot preview, open, or reuse the file from chat.

## Product Requirements

- Assistant-created files render as attachment cards on the assistant message that produced them.
- Image outputs show thumbnails when Core can read the file.
- Audio, video, document, archive, code, and unknown files show type-specific icons and can be opened or downloaded.
- The literal `MEDIA:/path`, `Image: /path`, or `File: /path` marker should not remain as the only access path. It can be removed from rendered prose once an attachment card exists.
- Streaming replies should work when the final text arrives before the file delivery, after the file delivery, or in the same delivery payload.
- Conversation reload should preserve assistant attachments, not just the live provisional state.
- Generated files should be copied into `~/.iris/attachments`; UI should not depend on `/tmp` paths remaining alive.
- Do not edit Hermes under `~/.hermes` for the first implementation.
- Do not expose arbitrary runtime paths to the desktop client except as trusted internal metadata for Core ingestion.

## Target Contract

Use the same client-facing attachment shape for user and assistant messages:

```ts
type MessageAttachment = {
  id: string;
  name: string;
  kind: "image" | "document" | "audio" | "video" | "archive" | "code" | "file";
  mimeType: string;
  size: number;
  previewUrl?: string;
  downloadUrl?: string;
  localPath?: string;
  legacyLocalPath?: boolean;
};
```

Assistant delivery metadata should support a structured file list:

```json
{
  "generatedFiles": [
    {
      "path": "/tmp/red_hue_relief.png",
      "name": "red_hue_relief.png",
      "mimeType": "image/png",
      "kind": "image"
    }
  ]
}
```

For compatibility with current Hermes behavior, Iris Core should also parse file markers from assistant text:

```text
MEDIA:/tmp/red_hue_relief.png
Image: /tmp/red_hue_relief.png
File: /tmp/red_hue_relief.png
```

The Core-facing event metadata after ingestion should contain client-safe attachments:

```json
{
  "attachments": [
    {
      "id": "att_...",
      "name": "red_hue_relief.png",
      "kind": "image",
      "mimeType": "image/png",
      "size": 123456,
      "sha256": "...",
      "previewUrl": "/v1/attachments/att_.../preview",
      "downloadUrl": "/v1/attachments/att_.../content"
    }
  ],
  "generatedFiles": [
    {
      "path": "/tmp/red_hue_relief.png",
      "name": "red_hue_relief.png"
    }
  ]
}
```

`generatedFiles` is internal compatibility metadata. The desktop renderer should use `attachments`.

## Backend Implementation

### 1. Add Generated File Extraction

Add helpers near the existing attachment helpers in `sidecar/src/hermes_management_server/main.py`, or move them into a small `attachments.py` module if the file gets too large:

- `generated_file_refs_from_delivery(content: str, metadata: dict) -> list[dict]`
- `generated_file_refs_from_text(content: str) -> list[dict]`
- `strip_generated_file_markers(content: str, attachments: list[dict]) -> str`

The parser should support one file per line and these prefixes:

- `MEDIA:`
- `Media:`
- `Image:`
- `File:`
- optional leading labels already seen in gateway output, such as `Generated file:`

Keep parsing conservative:

- Only treat a marker as a file when the value is an absolute local path or a file URL.
- Ignore normal prose that merely mentions `File:` in the middle of a sentence.
- Deduplicate by resolved path.
- Do not fail the whole assistant message if one generated file cannot be imported; preserve the text marker and add a warning metadata field.

### 2. Import Assistant Files Into Core Attachments

Add a CoreStore method, likely in `sidecar/src/hermes_management_server/core_store.py`:

```py
def create_attachment_from_path(
    self,
    *,
    source_path: Path,
    runtime_id: str,
    profile: str,
    conversation_id: str,
    message_id: str,
    name: str = "",
    kind: str = "",
    mime_type: str = "",
    metadata: dict[str, Any] | None = None,
) -> dict[str, Any]:
    ...
```

This should reuse the same validation and blob storage path as upload handling:

- Validate file exists and is a file.
- Reject empty files.
- Enforce `max_attachment_size_bytes()`.
- Hash the bytes.
- Sniff MIME with the existing `attachment_mime_type()` logic.
- Classify kind with `attachment_kind()`.
- Copy, not move, from runtime path into `~/.iris/attachments/blobs/...`.
- Store metadata such as `createdBy: "assistant"`, original path, delivery id, and source.

Use `copy` rather than `move` because the file belongs to the runtime/tool environment. Core should create its own durable copy.

### 3. Link Attachments To Assistant Messages

`message_attachments` already has `message_id`, `attachment_id`, and position, and it does not need to care whether the message role is user or assistant.

Add a helper that links already-created attachment rows to a message:

```py
def link_message_attachments(
    self,
    *,
    runtime_id: str,
    profile: str,
    chat_id: str,
    message_id: str,
    attachments: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    ...
```

This prevents overloading `resolve_message_attachments()`, which is currently user-send oriented and expects client refs.

### 4. Ingest Files During Runtime Delivery

In `runtime_delivery_hermes()` and `mirror_inbox_message_to_core()`:

1. Resolve the conversation and message id as today.
2. Extract generated file refs from `delivery.metadata.generatedFiles`, `delivery.metadata.attachments` when they contain local paths, and compatibility text markers.
3. Import each readable file into Core storage.
4. Add `metadata.attachments = [client_attachment_payload(...)]`.
5. Preserve internal import details under a separate key, for example `generatedFileImports`.
6. Strip marker-only lines from `content` when at least one attachment was imported.
7. Publish the event with cleaned content plus attachment metadata.

This gives live SSE deliveries enough metadata for the desktop to render attachment cards immediately.

### 5. Preserve Attachments Through Stream Coalescing

`prepare_assistant_delivery_event()`, `merged_completion_metadata()`, and `coalesce_core_messages()` already merge stream and post-stream content. They also need to merge metadata attachments:

- When a file delivery follows a completed streamed message, merge `attachments` arrays onto the streamed assistant message metadata.
- Deduplicate by `id`, then by `sha256`, then by `downloadUrl`.
- Keep `streamMessageId`, `replyTo`, and finalization metadata intact.
- If cleaned file-marker content becomes empty, still keep the attachment metadata on the assistant message.

Without this, live rendering may work briefly but canonical history can lose the attachment when the final stream row replaces the media row.

### 6. Preserve Attachments On Conversation Reload

`sidecar/src/hermes_management_server/runtime_adapters/hermes.py` currently only overlays client metadata onto user messages. Expand `with_client_message_metadata()` so assistant messages can also receive metadata overlays.

Important detail: assistant output files may not be written into Hermes history with the same id as the Iris delivery event. Use multiple lookup keys:

- runtime/external message id when available
- `streamMessageId`
- content hash candidates before marker stripping
- content hash candidates after marker stripping
- chat id plus nearby timestamp if available

If exact history overlay is too brittle for v1, it is acceptable to keep assistant-generated file metadata in Core events and have `/v1/conversations/{id}/messages` merge recent Core assistant events over the runtime history for that conversation. The stronger long-term shape is event replay as the durable source for Iris overlays while Hermes remains canonical for runtime conversation text.

## Desktop Implementation

### 1. Extract Attachments For Assistant Messages

Update `desktop/src/features/chat/chatHistory.ts`:

```ts
const attachments = message.role === "user" || message.role === "assistant"
  ? attachmentsFromMetadata(message.metadata)
  : [];
```

Keep tool and system messages attachment-free unless a real product need appears.

Also stop collapsing every non-`image` attachment to `"file"` in `attachmentsFromMetadata()`. It should preserve all existing `AttachmentKind` values that are now supported by `desktop/src/app/types.ts`.

### 2. Carry Attachments Through Live Delivery Merging

Update `desktop/src/features/chat/chatStreamMerging.ts` so `HermesInboxMessage.metadata.attachments` becomes `Message.attachments` for assistant deliveries.

Add helpers:

- `attachmentsFromDelivery(delivery)`
- `mergeMessageAttachments(left, right)`
- `contentWithoutRenderedAttachmentMarkers(content, attachments)`

Apply them in:

- new assistant messages created by `mergeStreamDelivery()`
- new assistant messages created by `mergeCompletedDelivery()`
- `completedStreamingMessage()`
- `coalescePostStreamAttachments()`

The provisional behavior should become:

```ts
{
  role: "assistant",
  content: "Done - here's the red-hue version:",
  attachments: [
    {
      id: "att_...",
      name: "red_hue_relief.png",
      kind: "image",
      mimeType: "image/png",
      previewUrl: "http://127.0.0.1:8765/v1/attachments/att_.../preview",
      downloadUrl: "http://127.0.0.1:8765/v1/attachments/att_.../content",
      size: ...
    }
  ]
}
```

### 3. Render Assistant Attachment Alignment Correctly

`MessageAttachments` already renders cards, but CSS currently assumes user-message alignment in `.message-attachments`.

Add role-aware layout:

```css
.message.assistant .message-attachments {
  align-self: flex-start;
  justify-content: flex-start;
}

.message.user .message-attachments {
  align-self: flex-end;
  justify-content: flex-end;
}
```

Assistant file cards should appear above the assistant body/tool output, matching the existing message structure in `ChatView.tsx`.

### 4. Keep Open/Preview Behavior Shared

Do not create a separate assistant-file component. Keep using `MessageAttachments` from `desktop/src/features/chat/components/MessageContent.tsx` so user and assistant files share:

- Core preview URL handling
- Core content URL handling
- Tauri `convertFileSrc()` fallback for legacy local image paths
- type labels from `desktop/src/shared/files.ts`
- lucide icons for non-images

## API And Data Model Notes

No new desktop-visible endpoint is required for v1 if Core imports generated files during delivery.

Possible later endpoint:

```http
POST /v1/runtime/attachments
```

This would let a remote runtime upload generated bytes directly when Core cannot read a local runtime path. It is not required for the local Hermes-first implementation, but the design should not block it.

For local v1:

- Runtime delivery endpoint is trusted and authenticated.
- Core may read local generated file paths because Core and Hermes run on the same machine.
- Core returns only client-safe attachment payloads to the desktop.
- Core keeps original runtime paths only in internal metadata for debugging.

## Security Rules

- Do not serve arbitrary local paths directly to the desktop.
- Do not trust assistant text as authorization to expose files outside the runtime output context.
- Only import paths from authenticated runtime deliveries or legacy inbox messages.
- Prefer generated file paths under known runtime temp/output roots, such as `/tmp`, Hermes work dirs, or `~/.iris/attachments`, but do not hard-code only one path in the parser.
- Never execute generated files to classify them.
- For HTML/SVG, store and download as files; do not render active HTML in chat.
- Keep `/v1/attachments/{id}/preview` image-only unless a later preview pipeline sanitizes other types.

## Tests

### Sidecar Tests

Add tests in `sidecar/tests/test_api.py` and/or a dedicated attachment test:

- Runtime delivery with `content="Done\n\nMEDIA:/tmp/red_hue_relief.png"` imports the PNG and publishes metadata attachments.
- Published event content removes the marker line after successful import.
- `/v1/attachments/{id}/preview` returns `200 image/png` for imported PNGs.
- `/v1/attachments/{id}/content` returns stored bytes for audio/document outputs.
- Missing generated file leaves text intact and adds a warning without failing the assistant message.
- Post-stream file delivery merges attachment metadata into the final streamed assistant message.
- Conversation reload returns assistant messages with `metadata.attachments`.
- Non-image generated files do not get image preview URLs.

### Desktop Tests

Extend `desktop/src/features/chat/__tests__/useIrisChat.test.ts`:

- `toAppMessages()` maps assistant `metadata.attachments` into `Message.attachments`.
- `mergeCompletedDelivery()` creates an assistant message with attachments from delivery metadata.
- `mergeStreamDelivery()` preserves attachments when finalizing a stream.
- A file delivery after a completed stream merges attachments into the existing assistant message.
- Marker text is stripped only when an attachment object exists; normal prose mentioning `File:` is preserved.

Extend `desktop/src/lib/__tests__/agentuiCore.test.ts` only if new URL normalization or attachment contracts are added.

### Manual Verification

Use the repo-required desktop verification path for the final implementation:

1. Start the sidecar/Core normally.
2. Ask the agent to create an image.
3. Confirm the assistant message shows an image thumbnail and opens the Core content URL.
4. Ask the agent to transform a user-provided image and return a new file.
5. Confirm the generated output appears as an assistant attachment, not only `MEDIA:/tmp/...`.
6. Ask for an audio file or small text/document artifact.
7. Confirm non-image outputs show a type-specific card and open/download.
8. Refresh/reopen the conversation and confirm attachments persist.
9. Run `npm run build:mac:app`.
10. Launch the fresh app bundle.
11. Verify with Computer Use against `com.nousresearch.hermes-agent.desktop`.

## Implementation Order

1. Backend parser and CoreStore path import helper.
2. Runtime delivery ingestion attaches generated files to event metadata.
3. Stream/coalescing metadata merge on the backend.
4. Conversation reload overlay for assistant attachment metadata.
5. Desktop extraction of assistant attachments from metadata.
6. Desktop stream merge support for delivery metadata attachments.
7. Role-aware attachment alignment CSS.
8. Sidecar and desktop regression tests.
9. Fresh Tauri app build and Computer Use verification.

## Open Questions

- Should assistant-generated files created outside `/tmp` be accepted by default, or should v1 restrict imports to known runtime output roots?
- Should Core expose a separate `generatedFiles` debug field in API responses, or keep original paths completely internal?
- For remote runtimes, should the first supported path be a runtime upload endpoint or signed remote URLs?
- Should assistant attachments appear above tool activity, below tool activity, or directly before final assistant text? The current message structure puts attachments above the message body, which is the least invasive first pass.

