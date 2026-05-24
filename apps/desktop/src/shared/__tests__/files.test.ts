import { describe, expect, it } from "vitest";
import {
  attachmentKindFromPath,
  attachmentTypeLabel,
  isPreviewableImage,
  mimeTypeFromPath,
} from "../files";

describe("attachment file classification", () => {
  it.each([
    ["photo.png", "image/png", "image"],
    ["photo.jpg", "image/jpeg", "image"],
    ["photo.gif", "image/gif", "image"],
    ["photo.webp", "image/webp", "image"],
    ["photo.heic", "image/heic", "image"],
    ["photo.avif", "image/avif", "image"],
    ["vector.svg", "image/svg+xml", "image"],
    ["brief.pdf", "application/pdf", "document"],
    ["brief.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "document"],
    ["budget.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "document"],
    ["deck.pptx", "application/vnd.openxmlformats-officedocument.presentationml.presentation", "document"],
    ["data.csv", "text/csv", "document"],
    ["notes.rtf", "application/rtf", "document"],
    ["book.epub", "application/epub+zip", "document"],
    ["song.mp3", "audio/mpeg", "audio"],
    ["voice.wav", "audio/wav", "audio"],
    ["clip.m4a", "audio/mp4", "audio"],
    ["mix.flac", "audio/flac", "audio"],
    ["movie.mp4", "video/mp4", "video"],
    ["movie.mov", "video/quicktime", "video"],
    ["movie.webm", "video/webm", "video"],
    ["files.zip", "application/zip", "archive"],
    ["files.tar", "application/x-tar", "archive"],
    ["files.gz", "application/gzip", "archive"],
    ["files.7z", "application/x-7z-compressed", "archive"],
    ["app.ts", "text/typescript", "code"],
    ["app.js", "text/javascript", "code"],
    ["script.py", "text/x-python", "code"],
    ["tool.rb", "text/x-ruby", "code"],
    ["main.go", "text/x-go", "code"],
    ["lib.rs", "text/x-rust", "code"],
    ["config.yaml", "application/yaml", "code"],
    ["config.toml", "application/toml", "code"],
    ["blob.unknown", "application/octet-stream", "file"],
  ])("%s maps to %s and %s", (filename, mimeType, kind) => {
    expect(mimeTypeFromPath(filename)).toBe(mimeType);
    expect(attachmentKindFromPath(filename)).toBe(kind);
  });

  it("keeps SVG classified as image without treating it as a bitmap preview", () => {
    expect(isPreviewableImage("image/png", "photo.png")).toBe(true);
    expect(isPreviewableImage("image/svg+xml", "vector.svg")).toBe(false);
  });

  it("returns user-facing labels for attachment kinds", () => {
    expect(attachmentTypeLabel("audio", "audio/mpeg")).toBe("Audio");
    expect(attachmentTypeLabel("video", "video/mp4")).toBe("Video");
    expect(attachmentTypeLabel("file", "application/octet-stream")).toBe("Unknown file");
  });
});
