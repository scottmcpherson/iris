# Remote-Safe Attachments Implementation Plan

## Architectural Constraint

Every attachment feature must work when Iris Desktop is not running on the same
machine as Iris Core or Hermes.

Do not design around shared filesystem paths. A path such as
`/Users/scott/Desktop/image.png` is only meaningful on the client that selected
the file. Hermes, Iris Core, future mobile clients, and future web clients must
communicate through Core-owned attachment records and byte transport.

Local-path behavior may remain as a development optimization, but it must not be
the product contract.

## Goal

Replace the current attachment flow with a Core-managed upload and resolution
flow:

```text
Iris client
  selects file/photo
  uploads bytes to Iris Core
  sends message with attachment ids

Iris Core
  stores attachment bytes and metadata
  owns authorization and retention
  persists message attachment references
  exposes previews/downloads to clients
  gives runtime adapters a runtime-readable representation

Hermes runtime adapter
  forwards message text plus normalized attachment references
  materializes files on the Hermes/Core host when Hermes tools need local paths
```

The end state is that desktop, mobile, and web all use the same attachment API.
No client should need to know whether Hermes is local, remote over Tailscale, or
running behind another runtime adapter.

## Current Behavior

The desktop chat UI has two attachment input paths in
`desktop/src/features/chat/ChatView.tsx`:

- File picker:
  - `addFiles(fileList)` stores browser `File` metadata and an object URL
    preview.
  - It does not currently preserve the `File` bytes past the draft state in a
    Core-uploaded form.

- Drag/drop local paths:
  - `addPaths(paths)` stores the local path directly.
  - Image previews use `convertFileSrc(path)`.

The send path in `desktop/src/features/chat/useHermesChat.ts` currently:

- Builds a user-facing optimistic `Message` with `attachments`.
- Builds `promptWithAttachments` with a text summary including `path` when one
  exists.
- Sends `attachments` and `metadata.attachments` to Core through
  `sendAgentUICoreMessage`.

The Core send endpoint in
`sidecar/src/hermes_management_server/main.py` currently:

- Accepts `CoreMessageCreateRequest.attachments`.
- Copies them into `runtime_metadata.attachments`.
- Persists that metadata in `client_message_metadata`.
- Sends the message to the Hermes AgentUI gateway through
  `HermesRuntimeAdapter.send_message`.

The Hermes adapter in
`sidecar/src/hermes_management_server/runtime_adapters/hermes.py` currently:

- Sends `text` plus `metadata`.
- Does not upload bytes, read files, or create runtime-safe attachment assets.

This works only when Hermes can read the same local path that the desktop app
selected.

## Non-Goals

- Do not build the mobile app in this phase.
- Do not require a cloud backend.
- Do not expose attachment downloads to the public internet.
- Do not require Hermes core changes for the first pass.
- Do not remove local previews in the desktop composer.
- Do not store attachment bytes in Hermes-owned transcript storage.
- Do not make Core the source of truth for Hermes messages beyond Core-owned
  overlay metadata and attachment records.

## Data Model

Add Core-owned attachment tables in
`sidecar/src/hermes_management_server/core_store.py`.

### `attachments`

One row per uploaded file/blob.

Columns:

- `id text primary key`
- `owner_device_id text`
- `runtime_id text not null`
- `profile text not null`
- `conversation_id text`
- `message_id text`
- `name text not null`
- `mime_type text not null`
- `kind text not null`
- `size_bytes integer not null`
- `sha256 text not null`
- `storage_kind text not null`
- `storage_path text not null`
- `created_at integer not null`
- `updated_at integer not null`
- `deleted_at integer`
- `metadata_json text not null`

Indexes:

- `(runtime_id, profile, conversation_id)`
- `(runtime_id, profile, message_id)`
- `(sha256)`

Notes:

- `storage_path` is a Core-host path, not a client path.
- `metadata_json` may include image dimensions, EXIF scrub state, upload source,
  and client-reported metadata.
- Use a generated `att_...` id; do not trust client ids as primary ids.

### `message_attachments`

Join table so one uploaded attachment can be referenced by a message without
copying metadata into every row.

Columns:

- `runtime_id text not null`
- `profile text not null`
- `chat_id text not null`
- `message_id text not null`
- `attachment_id text not null`
- `position integer not null`
- `created_at integer not null`
- Primary key `(runtime_id, profile, chat_id, message_id, attachment_id)`

Keep `client_message_metadata` for compatibility, but store only normalized
attachment references there:

```json
{
  "attachments": [
    {
      "id": "att_...",
      "name": "photo.jpg",
      "kind": "image",
      "mimeType": "image/jpeg",
      "size": 123456,
      "sha256": "...",
      "previewUrl": "/v1/attachments/att_.../preview",
      "downloadUrl": "/v1/attachments/att_.../content"
    }
  ]
}
```

Do not persist client-local `path` in returned message metadata except in a
diagnostic field that is never required for runtime behavior.

## Storage

Default local storage under the Core host:

```text
~/.iris/attachments/
  blobs/
    sha256-prefix/
      sha256
  previews/
    att_....jpg
```

Core should write uploads atomically:

1. Stream upload to a temp file under `~/.iris/attachments/tmp`.
2. Compute SHA-256 while streaming.
3. Move to the content-addressed blob path.
4. Create or update the `attachments` row.

For duplicate bytes, reuse the blob path but create a separate attachment row if
the message/conversation context differs. This keeps retention and audit simple.

Set conservative limits initially:

- Max attachment size: 25 MB.
- Max attachments per message: 8.
- Allowed initial MIME types:
  - `image/png`
  - `image/jpeg`
  - `image/webp`
  - `image/gif`
  - `application/pdf`
  - `text/plain`
  - `text/markdown`

Reject unknown binary types until the UX and runtime tool handling are explicit.

## API Contract

Add these endpoints to `sidecar/src/hermes_management_server/main.py`.

### Create Upload

```http
POST /v1/attachments
Content-Type: multipart/form-data
```

Fields:

- `file`: file bytes.
- `conversationId`: optional at draft time.
- `messageId`: optional at draft time.
- `runtimeId`: optional, default local Hermes.
- `profile`: required or derived from selected agent/profile.
- `kind`: optional client hint, Core validates.
- `metadata`: optional JSON string.

Response:

```json
{
  "ok": true,
  "attachment": {
    "id": "att_...",
    "name": "photo.jpg",
    "kind": "image",
    "mimeType": "image/jpeg",
    "size": 123456,
    "sha256": "...",
    "createdAt": 1778150000,
    "previewUrl": "/v1/attachments/att_.../preview",
    "downloadUrl": "/v1/attachments/att_.../content"
  }
}
```

### Attach To Message

```http
POST /v1/conversations/{conversation_id}/messages
```

Change request shape from loose attachment dictionaries to ids:

```json
{
  "text": "what is this?",
  "clientMessageId": "client-uuid",
  "attachments": [
    { "id": "att_..." }
  ],
  "metadata": {}
}
```

Core resolves each id, verifies authorization/profile ownership, binds it to
the accepted message id, and stores the normalized message attachment references.

During a transition period, Core may still accept legacy attachment objects with
`path`, but it should mark them as `legacyLocalPath: true` and should not treat
them as remote-safe.

### Download Original

```http
GET /v1/attachments/{attachment_id}/content
```

Returns bytes with:

- `Content-Type`
- `Content-Length`
- `Content-Disposition`
- `ETag` based on SHA-256

### Preview

```http
GET /v1/attachments/{attachment_id}/preview
```

For images, return a bounded thumbnail generated by Core. For PDFs/documents in
phase 1, return a JSON error or a placeholder metadata response; the UI can show
the document tile.

### Runtime Resolve

```http
POST /v1/runtime/attachments/resolve
```

Internal/runtime-facing endpoint. Given attachment ids and a runtime id, return
runtime-readable assets.

For local Hermes on the Core host:

```json
{
  "ok": true,
  "attachments": [
    {
      "id": "att_...",
      "name": "photo.jpg",
      "mimeType": "image/jpeg",
      "kind": "image",
      "path": "/Users/scott/.iris/attachments/blobs/ab/abcdef...",
      "sha256": "abcdef..."
    }
  ]
}
```

Future runtime adapters can return signed URLs or inline payload descriptors
instead of paths.

## Desktop Changes

### Preserve Bytes Until Upload

In `desktop/src/features/chat/ChatView.tsx`, split attachment drafts from sent
attachment references:

```ts
type AttachmentDraft = {
  id: string;
  name: string;
  kind: "image" | "file";
  mimeType: string;
  size: number;
  lastModified: number;
  file?: File;
  localPath?: string;
  previewUrl?: string;
  previewRevocable?: boolean;
  upload?: UploadedAttachment;
  uploadStatus: "local" | "uploading" | "uploaded" | "error";
  uploadError?: string;
};
```

For file picker uploads, keep `file`.

For drag/drop local paths in Tauri, add a bridge command that reads the selected
file and uploads it to Core. Do not pass the local path as the final attachment
contract. The local path may still be used for immediate preview with
`convertFileSrc`.

### Upload Before Send

Add `uploadAgentUICoreAttachment` to `desktop/src/lib/agentuiCore.ts`.

The happy path for send:

1. User selects files.
2. Composer shows immediate local previews.
3. On send, upload any draft not already uploaded.
4. If all uploads succeed, call `sendAgentUICoreMessage` with attachment ids.
5. Optimistic user message uses uploaded attachment metadata plus local preview
   URLs while available.
6. Persisted history uses Core preview/download URLs.

If upload fails, do not send the text message unless the user removes the failed
attachment or retries. This avoids accidentally sending a prompt that says an
image exists when Core cannot provide it to Hermes.

### Preview URLs

Update `MessageAttachment` in `desktop/src/app/types.ts`:

```ts
export type MessageAttachment = {
  id: string;
  name: string;
  kind: "image" | "file";
  mimeType: string;
  size: number;
  lastModified?: number;
  previewUrl?: string;
  downloadUrl?: string;
  localPath?: string;
  legacyLocalPath?: boolean;
};
```

Do not use `path` as the normal field in app-level attachment rendering. Use
`localPath` only for local preview fallback and legacy compatibility.

`MessageAttachments` should prefer:

1. `attachment.previewUrl`
2. Core absolute preview URL built from `/v1/attachments/{id}/preview`
3. `convertFileSrc(localPath)` only for legacy/local draft previews
4. document tile

## Core Send Changes

In `CoreMessageCreateRequest`, change attachment validation from
`list[dict[str, Any]]` to a typed model:

```py
class CoreMessageAttachmentRef(BaseModel):
    id: str

class CoreMessageCreateRequest(BaseModel):
    text: str
    attachments: list[CoreMessageAttachmentRef] = Field(default_factory=list)
    model: dict[str, Any] | None = None
    clientMessageId: str | None = None
    metadata: dict[str, Any] = Field(default_factory=dict)
```

During transition, optionally allow legacy dictionaries but normalize them in
one place:

```py
resolved_attachments = app.state.core_store.resolve_message_attachments(
    runtime_id=agent["runtimeId"],
    profile=agent["runtimeProfile"],
    conversation_id=conversation_id,
    chat_id=chat_id,
    message_id=message_id,
    refs=request.attachments,
)
```

Use `resolved_attachments` for:

- `runtime_metadata.attachments`
- `client_message_metadata`
- `message_attachments`
- runtime adapter send payload

Do not derive attachment availability from `text`.

## Hermes Adapter Changes

In `HermesRuntimeAdapter.send_message`, receive normalized attachment records in
metadata and resolve them before forwarding to the AgentUI gateway.

For the local Hermes adapter:

1. Resolve attachment ids to Core-host blob paths.
2. Build a message text attachment summary with Core-host paths, not client
   paths.
3. Include `metadata.attachments` with both stable ids and runtime paths:

```json
{
  "attachments": [
    {
      "id": "att_...",
      "name": "photo.jpg",
      "kind": "image",
      "mimeType": "image/jpeg",
      "size": 123456,
      "sha256": "...",
      "runtime": {
        "type": "local_path",
        "path": "/Users/scott/.iris/attachments/blobs/ab/abcdef..."
      }
    }
  ]
}
```

Hermes can continue to use local paths for vision tools in phase 1, but those
paths must be Core-host paths.

Do not expose the original client path to Hermes as the tool input.

## History And Reconciliation

`client_message_metadata` should continue to enrich Hermes-backed history in
`HermesRuntimeAdapter.with_client_message_metadata`, but it should merge
normalized attachment records from Core tables.

When history is returned to clients:

- Include `metadata.attachments`.
- Use `previewUrl` and `downloadUrl` that point at Core endpoints.
- Omit runtime-only `path` from client metadata unless explicitly requested for
  diagnostics.
- Strip the text `Attached files:` suffix from rendered user message content
  when attachments exist.

The desktop UI should no longer need local-path reconciliation for persisted
attachments. Mobile will consume the same `/messages` response.

## Security

Attachment APIs must be authenticated with the same Core auth model as messages.

Required checks:

- The requesting device/user can access the runtime/profile/conversation.
- Attachment ids in `POST /messages` belong to the same profile and device/user,
  or have already been explicitly attached to the same conversation.
- Paths never come from client input when resolving runtime-readable files.
- Download and preview endpoints do not allow path traversal.
- MIME type is validated by server-side sniffing when possible, not only by
  client headers.
- EXIF stripping should be added for generated previews. Preserve originals for
  runtime analysis unless the user chooses privacy scrubbing.

## Migration Plan

### Phase 1: Core Upload And Storage

- Add attachment tables and store methods in `core_store.py`.
- Add `POST /v1/attachments`.
- Add `GET /v1/attachments/{id}/content`.
- Add image preview endpoint or return original image bounded by response size
  for the first smoke.
- Add sidecar tests for upload, download, auth, MIME, size limits, and path
  traversal.

### Phase 2: Desktop Upload Before Send

- Add `uploadAgentUICoreAttachment` in `desktop/src/lib/agentuiCore.ts`.
- Keep `File` objects in `AttachmentDraft`.
- Upload attachments before `sendAgentUICoreMessage`.
- Send attachment ids instead of local paths.
- Preserve local object URL previews for optimistic rendering.
- Render persisted previews from Core URLs.
- Add Vitest coverage for attachment draft to uploaded attachment conversion.

### Phase 3: Runtime Resolution

- Add Core store method to resolve attachment ids to Core-host blob paths.
- Update `HermesRuntimeAdapter.send_message` to build runtime-safe attachment
  metadata and text summaries.
- Ensure `vision_analyze` receives a Core-host path.
- Add sidecar tests that prove a client path is not forwarded.

### Phase 4: History Normalization

- Update `client_message_metadata` writes to store normalized attachment refs.
- Update history enrichment to include Core preview/download URLs.
- Add tests for restored history after app restart.
- Remove dependence on attachment `path` in `MessageAttachments` for persisted
  messages.

### Phase 5: Legacy Cleanup

- Keep legacy local path support behind a clearly named compatibility path.
- Add warnings in development when a persisted attachment still contains only a
  client-local path.
- Remove local-path text summaries once Hermes adapter can handle attachment
  metadata directly.

## Verification

Automated:

- `cd sidecar && uv run python -m pytest`
- `npm --workspace desktop run test -- src/features/chat/__tests__/useHermesChat.test.ts`
- `npm --workspace desktop run build`

Required app verification for visible UI changes:

- Run `npm run build:mac:app`.
- Launch
  `/Users/scott/Development/agent-ui/desktop/src-tauri/target/release/bundle/macos/Iris.app`.
- Test with Computer Use against `com.nousresearch.hermes-agent.desktop`.

Manual smoke cases:

1. Desktop and Core on same Mac:
   - Upload image.
   - Send new chat.
   - Confirm Hermes can analyze image.
   - Confirm user message thumbnail survives assistant completion and app
     restart.

2. Simulated remote desktop:
   - Select an image from a client-only temp path.
   - Upload to Core.
   - Delete or move the original client file before sending.
   - Send message.
   - Confirm Hermes still analyzes the Core-stored image.

3. Document:
   - Upload PDF.
   - Send message.
   - Confirm document tile persists in history with download URL.

4. Failure:
   - Block Core upload or exceed size limit.
   - Confirm message is not sent with a phantom attachment.

## Acceptance Criteria

- No new attachment feature requires a shared client/Core/Hermes filesystem.
- Sent messages reference Core attachment ids, not client-local paths.
- Hermes tools receive Core-host paths or adapter-resolved runtime assets.
- Persisted history returns previews/document tiles using Core URLs.
- Desktop still feels instant through optimistic local previews.
- Mobile can implement attachment send with upload plus message send, without
  desktop-specific path or reconciliation logic.
