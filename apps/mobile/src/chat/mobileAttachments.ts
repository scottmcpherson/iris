import { useState } from "react";
import { Platform } from "react-native";
import * as DocumentPicker from "expo-document-picker";
import { File as ExpoFile } from "expo-file-system";
import * as ImagePicker from "expo-image-picker";
import {
  attachmentKindFromMime,
  mimeTypeFromName,
  type MessageAttachment,
} from "@iris/chat-core";
import {
  uploadAttachment,
  type IrisCoreAttachmentFile,
  type IrisCoreAttachmentKind,
  type IrisCoreClient,
} from "@iris/core-client";

export type MobileAttachmentDraft = MessageAttachment & {
  file?: File;
  uploadStatus: "local" | "uploading" | "uploaded" | "error";
  uploadError?: string;
};

type UploadDraftOptions = {
  profile: string;
  messageId: string;
  sessionId?: string;
};

export class MobileAttachmentUploadError extends Error {
  attachmentId: string;

  constructor(attachmentId: string, message: string) {
    super(message);
    this.name = "MobileAttachmentUploadError";
    this.attachmentId = attachmentId;
  }
}

export function useMobileAttachmentDrafts() {
  const [attachments, setAttachments] = useState<MobileAttachmentDraft[]>([]);

  async function addPickedFiles() {
    const result = await DocumentPicker.getDocumentAsync({
      copyToCacheDirectory: true,
      multiple: true,
      type: "*/*",
      base64: false,
    });
    if (result.canceled) return;
    setAttachments((current) => [
      ...current,
      ...result.assets.map(documentAssetToDraft),
    ]);
  }

  async function addPhotosFromLibrary() {
    const result = await ImagePicker.launchImageLibraryAsync({
      allowsMultipleSelection: true,
      mediaTypes: ["images", "videos"],
      quality: 0.92,
    });
    if (result.canceled) return;
    setAttachments((current) => [
      ...current,
      ...result.assets.map(imageAssetToDraft),
    ]);
  }

  async function takePhoto() {
    if (Platform.OS !== "web") {
      const permission = await ImagePicker.requestCameraPermissionsAsync();
      if (!permission.granted) throw new Error("Camera permission is required.");
    }
    const result = await ImagePicker.launchCameraAsync({
      mediaTypes: ["images"],
      quality: 0.92,
    });
    if (result.canceled) return;
    setAttachments((current) => [
      ...current,
      ...result.assets.map(imageAssetToDraft),
    ]);
  }

  function addVoiceRecording(recording: { uri: string; durationMillis: number }) {
    setAttachments((current) => [...current, voiceRecordingToDraft(recording)]);
  }

  function removeAttachment(id: string) {
    setAttachments((current) => current.filter((attachment) => attachment.id !== id));
  }

  function clearAttachments() {
    setAttachments([]);
  }

  async function uploadForSend(client: IrisCoreClient, options: UploadDraftOptions) {
    if (!attachments.length) return [];
    setAttachments((current) =>
      current.map((attachment) => ({
        ...attachment,
        uploadStatus: "uploading",
        uploadError: "",
      })),
    );

    const uploaded: MessageAttachment[] = [];
    for (const draft of attachments) {
      const result = await uploadDraftAttachment(client, draft, options);
      if (!result.ok || !result.attachment) {
        const message = uploadErrorMessage(draft.name, result.error);
        setAttachments((current) =>
          current.map((attachment) =>
            attachment.id === draft.id
              ? { ...attachment, uploadStatus: "error", uploadError: message }
              : attachment,
          ),
        );
        throw new MobileAttachmentUploadError(draft.id, message);
      }
      uploaded.push(mergeUploadedAttachment(draft, result.attachment as MessageAttachment));
      setAttachments((current) =>
        current.map((attachment) =>
          attachment.id === draft.id
            ? { ...attachment, uploadStatus: "uploaded", uploadError: "" }
            : attachment,
        ),
      );
    }
    return uploaded;
  }

  return {
    attachments,
    addPickedFiles,
    addPhotosFromLibrary,
    takePhoto,
    addVoiceRecording,
    removeAttachment,
    clearAttachments,
    uploadForSend,
  };
}

export async function uploadDraftAttachment(
  client: IrisCoreClient,
  draft: MobileAttachmentDraft,
  options: UploadDraftOptions,
) {
  const payload = {
    file: attachmentUploadFile(draft),
    name: draft.name,
    mimeType: draft.mimeType,
    kind: draft.kind as IrisCoreAttachmentKind,
    profile: options.profile,
    sessionId: options.sessionId,
    messageId: options.messageId,
    metadata: {
      clientDraftId: draft.id,
      lastModified: draft.lastModified || 0,
    },
  };
  const result = await uploadAttachment(client, payload);
  if (result.ok || !isUnsupportedAttachmentError(result.error) || payload.mimeType === "application/octet-stream") {
    return result;
  }
  return uploadAttachment(client, {
    ...payload,
    mimeType: "application/octet-stream",
    metadata: {
      ...payload.metadata,
      originalMimeType: draft.mimeType,
      uploadFallback: "octet-stream",
    },
  });
}

export function visibleAttachmentDrafts(attachments: MobileAttachmentDraft[]): MessageAttachment[] {
  return attachments.map((attachment) => ({
    id: attachment.id,
    name: attachment.name,
    kind: attachment.kind,
    mimeType: attachment.mimeType,
    size: attachment.size,
    lastModified: attachment.lastModified,
    previewUrl: attachment.previewUrl,
    downloadUrl: attachment.downloadUrl,
    localPath: attachment.localPath,
  }));
}

export function imageAssetToDraft(asset: ImagePicker.ImagePickerAsset): MobileAttachmentDraft {
  const name = asset.fileName || mediaFilename(asset.uri, asset.mimeType);
  const mimeType = asset.mimeType || mimeTypeFromName(name) || "image/jpeg";
  return {
    id: createAttachmentDraftId("image"),
    name,
    kind: attachmentKindFromMime(mimeType, name),
    mimeType,
    size: asset.fileSize ?? -1,
    lastModified: Date.now(),
    previewUrl: asset.uri,
    localPath: asset.uri,
    file: asset.file,
    uploadStatus: "local",
  };
}

export function documentAssetToDraft(asset: DocumentPicker.DocumentPickerAsset): MobileAttachmentDraft {
  const mimeType = asset.mimeType || mimeTypeFromName(asset.name);
  return {
    id: createAttachmentDraftId(),
    name: asset.name,
    kind: attachmentKindFromMime(mimeType, asset.name),
    mimeType,
    size: asset.size ?? -1,
    lastModified: asset.lastModified,
    previewUrl: mimeType.startsWith("image/") ? asset.uri : undefined,
    localPath: asset.uri,
    file: asset.file,
    uploadStatus: "local",
  };
}

export function voiceRecordingToDraft(recording: { uri: string; durationMillis: number }): MobileAttachmentDraft {
  const name = voiceRecordingFilename(recording.uri);
  const mimeType = voiceRecordingMimeType(name);
  return {
    id: createAttachmentDraftId("voice"),
    name,
    kind: "audio",
    mimeType,
    size: -1,
    lastModified: Date.now(),
    localPath: recording.uri,
    uploadStatus: "local",
  };
}

function attachmentUploadFile(draft: MobileAttachmentDraft): IrisCoreAttachmentFile {
  const uriFile = {
    uri: draft.localPath || draft.previewUrl || "",
    name: draft.name,
    type: draft.mimeType,
  };
  if (Platform.OS !== "web" && uriFile.uri) return nativeUploadFile(uriFile.uri, draft.name, draft.mimeType);
  if (draft.file) return draft.file;
  return uriFile;
}

function nativeUploadFile(uri: string, name: string, mimeType: string): IrisCoreAttachmentFile {
  const file = new ExpoFile(uri) as unknown as Blob & { name?: string; type?: string };
  defineReadonlyFallback(file, "name", name);
  defineReadonlyFallback(file, "type", mimeType);
  return file;
}

function defineReadonlyFallback(target: object, key: "name" | "type", value: string) {
  if (!value || (key in target && typeof (target as Record<string, unknown>)[key] === "string")) return;
  Object.defineProperty(target, key, {
    configurable: true,
    enumerable: true,
    value,
  });
}

function mergeUploadedAttachment(draft: MobileAttachmentDraft, uploaded: MessageAttachment): MessageAttachment {
  return {
    id: uploaded.id,
    name: uploaded.name || draft.name,
    kind: uploaded.kind || draft.kind,
    mimeType: uploaded.mimeType || draft.mimeType,
    size: uploaded.size >= 0 ? uploaded.size : draft.size,
    lastModified: draft.lastModified,
    previewUrl: uploaded.previewUrl || draft.previewUrl,
    downloadUrl: uploaded.downloadUrl,
    localPath: draft.localPath,
  };
}

function uploadErrorMessage(name: string, error = "") {
  const detail = error.trim() || "Upload failed.";
  return detail.includes(name) ? detail : `${name}: ${detail}`;
}

function isUnsupportedAttachmentError(error = "") {
  return /unsupported attachment type/i.test(error);
}

function mediaFilename(uri: string, mimeType?: string) {
  const cleanUri = uri.split("?")[0] || "";
  const uriName = cleanUri.split("/").filter(Boolean).pop();
  if (uriName && uriName.includes(".")) return uriName;
  if (mimeType === "video/mp4") return "video.mp4";
  if (mimeType === "video/quicktime") return "video.mov";
  if (mimeType === "video/webm") return "video.webm";
  if (mimeType === "image/png") return "photo.png";
  if (mimeType === "image/webp") return "photo.webp";
  if (mimeType === "image/gif") return "photo.gif";
  if (mimeType === "image/heic") return "photo.heic";
  if (mimeType === "image/heif") return "photo.heif";
  return "photo.jpg";
}

function voiceRecordingFilename(uri: string) {
  const lower = uri.toLowerCase();
  if (lower.endsWith(".mp4")) return "dictation.mp4";
  if (lower.endsWith(".aac")) return "dictation.aac";
  if (lower.endsWith(".wav")) return "dictation.wav";
  if (lower.endsWith(".webm")) return "dictation.webm";
  return "dictation.m4a";
}

function voiceRecordingMimeType(name: string) {
  if (name.endsWith(".webm")) return "audio/webm";
  if (name.endsWith(".mp4") || name.endsWith(".m4a")) return "audio/mp4";
  if (name.endsWith(".aac")) return "audio/aac";
  if (name.endsWith(".wav")) return "audio/wav";
  return "audio/mp4";
}

function createAttachmentDraftId(prefix = "attachment") {
  const random = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}-${random}`;
}
