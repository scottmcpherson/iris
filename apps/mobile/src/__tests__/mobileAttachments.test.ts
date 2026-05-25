import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  documentAssetToDraft,
  imageAssetToDraft,
  uploadDraftAttachment,
  voiceRecordingToDraft,
  type MobileAttachmentDraft,
} from "../chat/mobileAttachments";

const uploadAttachment = vi.hoisted(() => vi.fn());
const ExpoFile = vi.hoisted(() =>
  vi.fn(function MockExpoFile(this: { uri: string; name: string; bytes: () => Promise<Uint8Array> }, uri: string) {
    this.uri = uri;
    this.name = uri.split("/").pop() || "file";
    this.bytes = async () => new Uint8Array([1, 2, 3]);
  }),
);

vi.mock("react-native", () => ({
  Platform: { OS: "ios" },
}));

vi.mock("expo-document-picker", () => ({
  getDocumentAsync: vi.fn(),
}));

vi.mock("expo-file-system", () => ({
  File: ExpoFile,
}));

vi.mock("expo-image-picker", () => ({
  launchImageLibraryAsync: vi.fn(),
  launchCameraAsync: vi.fn(),
  requestCameraPermissionsAsync: vi.fn(),
}));

vi.mock("@iris/core-client", () => ({
  uploadAttachment: (...args: unknown[]) => uploadAttachment(...args),
}));

describe("mobile attachments", () => {
  beforeEach(() => {
    uploadAttachment.mockReset();
  });

  it("keeps arbitrary document picker MIME types as file attachments", () => {
    const draft = documentAssetToDraft({
      name: "data.sqlite",
      uri: "file:///tmp/data.sqlite",
      mimeType: "application/vnd.sqlite3",
      size: 12,
      lastModified: 1,
    });

    expect(draft).toMatchObject({
      name: "data.sqlite",
      kind: "file",
      mimeType: "application/vnd.sqlite3",
      localPath: "file:///tmp/data.sqlite",
      uploadStatus: "local",
    });
  });

  it("creates native Expo file upload payloads for voice recordings", async () => {
    uploadAttachment.mockResolvedValueOnce({
      ok: true,
      attachment: {
        id: "att_voice",
        name: "dictation.m4a",
        kind: "audio",
        mimeType: "audio/mp4",
        size: 10,
      },
    });

    const draft = voiceRecordingToDraft({ uri: "file:///tmp/recording.m4a", durationMillis: 1200 });
    await uploadDraftAttachment({ transport: { baseUrl: "http://core.local", fetch } }, draft, {
      profile: "default",
      messageId: "message_1",
    });

    expect(uploadAttachment).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        file: expect.objectContaining({ uri: "file:///tmp/recording.m4a", type: "audio/mp4" }),
        kind: "audio",
        mimeType: "audio/mp4",
      }),
    );
  });

  it("uses native Expo file payloads for image picker files when Expo also provides a File", async () => {
    uploadAttachment.mockResolvedValueOnce({
      ok: true,
      attachment: {
        id: "att_image",
        name: "IMG_0111.heic",
        kind: "image",
        mimeType: "image/heic",
        size: 10,
      },
    });

    const draft = imageAssetToDraft({
      uri: "file:///tmp/IMG_0111.heic",
      fileName: "IMG_0111.heic",
      mimeType: "image/heic",
      fileSize: 10,
      width: 100,
      height: 100,
      file: { name: "IMG_0111.heic" } as File,
    });
    await uploadDraftAttachment({ transport: { baseUrl: "http://core.local", fetch } }, draft, {
      profile: "default",
      messageId: "message_1",
    });

    expect(uploadAttachment).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        file: expect.objectContaining({ uri: "file:///tmp/IMG_0111.heic", type: "image/heic" }),
        kind: "image",
        mimeType: "image/heic",
      }),
    );
  });

  it("keeps video picker assets as video attachments", () => {
    const draft = imageAssetToDraft({
      uri: "file:///tmp/asset-without-extension",
      fileName: null,
      mimeType: "video/mp4",
      fileSize: 1024,
      width: 320,
      height: 240,
    });

    expect(draft).toMatchObject({
      name: "video.mp4",
      kind: "video",
      mimeType: "video/mp4",
      localPath: "file:///tmp/asset-without-extension",
      uploadStatus: "local",
    });
  });

  it("retries unsupported mobile uploads as octet-stream for arbitrary file types", async () => {
    uploadAttachment
      .mockResolvedValueOnce({ ok: false, error: "Unsupported attachment type: application/vnd.sqlite3." })
      .mockResolvedValueOnce({
        ok: true,
        attachment: {
          id: "att_sqlite",
          name: "data.sqlite",
          kind: "file",
          mimeType: "application/octet-stream",
          size: 12,
        },
      });
    const draft: MobileAttachmentDraft = {
      id: "attachment-1",
      name: "data.sqlite",
      kind: "file",
      mimeType: "application/vnd.sqlite3",
      size: 12,
      lastModified: 1,
      localPath: "file:///tmp/data.sqlite",
      uploadStatus: "local",
    };

    const result = await uploadDraftAttachment({ transport: { baseUrl: "http://core.local", fetch } }, draft, {
      profile: "default",
      messageId: "message_1",
    });

    expect(result.ok).toBe(true);
    expect(uploadAttachment).toHaveBeenCalledTimes(2);
    expect(uploadAttachment.mock.calls[1]?.[1]).toMatchObject({
      mimeType: "application/octet-stream",
      metadata: {
        originalMimeType: "application/vnd.sqlite3",
        uploadFallback: "octet-stream",
      },
    });
  });
});
