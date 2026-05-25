import type { AttachmentKind, MessageAttachment } from "./types";

export function formatAttachmentSize(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  const precision = value >= 10 || unitIndex === 0 ? 0 : 1;
  return `${value.toFixed(precision)} ${units[unitIndex]}`;
}

export function mimeTypeFromName(name: string) {
  const extension = fileExtension(name);
  return extension ? EXTENSION_MIME_TYPES[extension] || "application/octet-stream" : "application/octet-stream";
}

export function attachmentKindFromMime(mimeType: string, filename = ""): AttachmentKind {
  const normalizedMime = normalizeMimeType(mimeType);
  const extension = fileExtension(filename);
  if (normalizedMime.startsWith("image/")) return "image";
  if (normalizedMime.startsWith("audio/")) return "audio";
  if (normalizedMime.startsWith("video/")) return "video";
  if (DOCUMENT_MIME_TYPES.has(normalizedMime)) return "document";
  if (ARCHIVE_MIME_TYPES.has(normalizedMime)) return "archive";
  if (CODE_MIME_TYPES.has(normalizedMime) || CODE_EXTENSIONS.has(extension)) return "code";
  if (normalizedMime.startsWith("text/")) return "code";
  if (DOCUMENT_EXTENSIONS.has(extension)) return "document";
  if (AUDIO_EXTENSIONS.has(extension)) return "audio";
  if (VIDEO_EXTENSIONS.has(extension)) return "video";
  if (ARCHIVE_EXTENSIONS.has(extension)) return "archive";
  return "file";
}

export function attachmentTypeLabel(kind: AttachmentKind, mimeType = "") {
  const normalizedMime = normalizeMimeType(mimeType);
  if (kind === "image") return "Image";
  if (kind === "document") return documentLabel(normalizedMime);
  if (kind === "audio") return "Audio";
  if (kind === "video") return "Video";
  if (kind === "archive") return "Archive";
  if (kind === "code") return "Code";
  return normalizedMime && normalizedMime !== "application/octet-stream" ? "File" : "Unknown file";
}

export function formatPromptWithAttachments(prompt: string, attachments: MessageAttachment[]) {
  if (!attachments.length) return prompt;
  const attachmentSummary = attachments
    .map((attachment, index) => {
      const type = attachment.mimeType || (attachment.kind === "image" ? "image" : "file");
      const size = attachment.size >= 0 ? formatAttachmentSize(attachment.size) : "size unknown";
      return `${index + 1}. ${attachment.name} (${type}, ${size})`;
    })
    .join("\n");

  if (!prompt.trim()) return attachmentSummary;
  return [prompt, `Attached files:\n${attachmentSummary}`].join("\n\n");
}

function normalizeMimeType(value: string) {
  const mimeType = String(value || "").split(";", 1)[0].trim().toLowerCase();
  if (mimeType === "image/jpg") return "image/jpeg";
  return mimeType || "application/octet-stream";
}

function fileExtension(path: string) {
  return path.split(/[\\/]/).pop()?.split(".").pop()?.toLowerCase() || "";
}

function documentLabel(mimeType: string) {
  if (mimeType === "application/pdf") return "PDF";
  if (mimeType.includes("word") || mimeType.includes("wordprocessingml")) return "Document";
  if (mimeType.includes("spreadsheet") || mimeType.includes("excel")) return "Spreadsheet";
  if (mimeType.includes("presentation") || mimeType.includes("powerpoint")) return "Presentation";
  return "Document";
}

const EXTENSION_MIME_TYPES: Record<string, string> = {
  avif: "image/avif",
  bmp: "image/bmp",
  gif: "image/gif",
  heic: "image/heic",
  heif: "image/heif",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  svg: "image/svg+xml",
  tif: "image/tiff",
  tiff: "image/tiff",
  webp: "image/webp",
  pdf: "application/pdf",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  odt: "application/vnd.oasis.opendocument.text",
  ods: "application/vnd.oasis.opendocument.spreadsheet",
  odp: "application/vnd.oasis.opendocument.presentation",
  rtf: "application/rtf",
  csv: "text/csv",
  epub: "application/epub+zip",
  html: "text/html",
  htm: "text/html",
  json: "application/json",
  xml: "application/xml",
  md: "text/markdown",
  markdown: "text/markdown",
  txt: "text/plain",
  yaml: "application/yaml",
  yml: "application/yaml",
  toml: "application/toml",
  js: "text/javascript",
  jsx: "text/javascript",
  ts: "text/typescript",
  tsx: "text/typescript",
  py: "text/x-python",
  rb: "text/x-ruby",
  go: "text/x-go",
  rs: "text/x-rust",
  java: "text/x-java-source",
  c: "text/x-c",
  h: "text/x-c",
  cpp: "text/x-c++",
  cc: "text/x-c++",
  css: "text/css",
  sh: "text/x-shellscript",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  m4a: "audio/mp4",
  aac: "audio/aac",
  ogg: "audio/ogg",
  flac: "audio/flac",
  mp4: "video/mp4",
  mov: "video/quicktime",
  m4v: "video/x-m4v",
  webm: "video/webm",
  mpg: "video/mpeg",
  mpeg: "video/mpeg",
  avi: "video/x-msvideo",
  zip: "application/zip",
  tar: "application/x-tar",
  gz: "application/gzip",
  tgz: "application/gzip",
  "7z": "application/x-7z-compressed",
  rar: "application/vnd.rar",
};

const DOCUMENT_EXTENSIONS = new Set([
  "pdf",
  "doc",
  "docx",
  "xls",
  "xlsx",
  "ppt",
  "pptx",
  "odt",
  "ods",
  "odp",
  "rtf",
  "csv",
  "epub",
  "html",
  "htm",
  "json",
  "xml",
]);
const AUDIO_EXTENSIONS = new Set(["mp3", "wav", "m4a", "aac", "ogg", "flac"]);
const VIDEO_EXTENSIONS = new Set(["mp4", "mov", "m4v", "webm", "mpg", "mpeg", "avi"]);
const ARCHIVE_EXTENSIONS = new Set(["zip", "tar", "gz", "tgz", "7z", "rar"]);
const CODE_EXTENSIONS = new Set([
  "md",
  "markdown",
  "txt",
  "yaml",
  "yml",
  "toml",
  "js",
  "jsx",
  "ts",
  "tsx",
  "py",
  "rb",
  "go",
  "rs",
  "java",
  "c",
  "h",
  "cpp",
  "cc",
  "css",
  "sh",
]);
const DOCUMENT_MIME_TYPES = new Set([
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/vnd.oasis.opendocument.text",
  "application/vnd.oasis.opendocument.spreadsheet",
  "application/vnd.oasis.opendocument.presentation",
  "application/rtf",
  "text/csv",
  "application/epub+zip",
]);
const ARCHIVE_MIME_TYPES = new Set([
  "application/zip",
  "application/x-tar",
  "application/gzip",
  "application/x-7z-compressed",
  "application/vnd.rar",
]);
const CODE_MIME_TYPES = new Set([
  "application/json",
  "application/xml",
  "application/yaml",
  "application/toml",
  "text/markdown",
  "text/javascript",
  "text/typescript",
  "text/x-python",
  "text/x-ruby",
  "text/x-go",
  "text/x-rust",
  "text/x-java-source",
  "text/x-c",
  "text/x-c++",
  "text/css",
  "text/x-shellscript",
]);
