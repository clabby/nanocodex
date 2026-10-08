import type { PromptAttachment } from "nanocodex-react/agent";

/** A prepared composer attachment: a protocol prompt item plus its presentation. */
export type ComposerAttachment = Readonly<{
  id: string;
  name: string;
  kind: "image" | "file" | "document";
  size: number;
  /** Image data URL used for the chip thumbnail; the same value is sent. */
  previewUrl?: string | undefined;
  item: PromptAttachment;
}>;

export type ComposerAttachmentPolicy = Readonly<{
  /** PDF documents are accepted only by models that read inline documents. */
  documents?: boolean | undefined;
  maxAttachments?: number | undefined;
}>;

export const MAX_ATTACHMENTS = 8;
const MAX_IMAGE_SOURCE_BYTES = 25 * 1024 * 1024;
const MAX_IMAGE_EDGE = 2048;
const MAX_INLINE_IMAGE_BYTES = 1_500_000;
const MAX_TEXT_BYTES = 256 * 1024;
const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
const TEXT_TYPES = new Set(["application/json", "application/xml", "application/x-yaml", "application/yaml",
  "application/javascript", "application/typescript", "application/x-sh", "application/sql", "application/toml"]);
const TEXT_EXTENSIONS = new Set(["txt", "md", "markdown", "csv", "tsv", "log", "json", "jsonl", "yaml", "yml", "toml", "ini",
  "xml", "html", "css", "scss", "js", "jsx", "mjs", "cjs", "ts", "tsx", "mts", "py", "rb", "rs", "go", "java", "kt", "swift",
  "c", "h", "cc", "cpp", "hpp", "cs", "php", "sh", "bash", "zsh", "sql", "graphql", "proto", "env", "diff", "patch", "vue", "svelte"]);

export class AttachmentRejection extends Error {}

/** File picker filter matching the attachment kinds the policy accepts. */
export function attachmentAccept(policy: ComposerAttachmentPolicy = {}): string {
  return [...IMAGE_TYPES, "text/*", ...TEXT_TYPES, ...[...TEXT_EXTENSIONS].map((name) => `.${name}`),
    ...(policy.documents ? ["application/pdf", ".pdf"] : [])].join(",");
}

/** Converts a dropped, pasted or picked file into a bounded prompt item. */
export async function prepareAttachment(file: File, policy: ComposerAttachmentPolicy = {}): Promise<ComposerAttachment> {
  const name = safeName(file.name || (file.type.startsWith("image/") ? "Pasted image" : "Attachment"));
  const id = randomId();
  if (IMAGE_TYPES.has(file.type)) {
    if (file.size > MAX_IMAGE_SOURCE_BYTES) throw new AttachmentRejection(`${name} is larger than 25 MB.`);
    const url = await imageDataUrl(file);
    return { id, name, kind: "image", size: file.size, previewUrl: url, item: { type: "image", image_url: url } };
  }
  if (file.type.startsWith("image/")) throw new AttachmentRejection(`${name}: use a PNG, JPEG, WebP or GIF image.`);
  if (file.type === "application/pdf" || extension(name) === "pdf") {
    if (!policy.documents) throw new AttachmentRejection(`${name}: PDFs need a Claude model. Images and text files work with every model.`);
    if (file.size > MAX_DOCUMENT_BYTES) throw new AttachmentRejection(`${name} is larger than 10 MB.`);
    const data = await readDataUrl(file, "application/pdf");
    return { id, name, kind: "document", size: file.size, item: { type: "file", file_data: data, filename: name } };
  }
  if (isTextFile(file, name)) {
    if (file.size > MAX_TEXT_BYTES) throw new AttachmentRejection(`${name} is larger than 256 KB.`);
    const text = await file.text();
    if (text.includes("\u0000")) throw new AttachmentRejection(`${name} is not a text file.`);
    const mediaType = file.type || "text/plain";
    return { id, name, kind: "file", size: file.size, item: { type: "text",
      text: `<attached_file name="${escapeAttribute(name)}" media_type="${escapeAttribute(mediaType)}">\n${text.replaceAll("</attached_file>", "<\\/attached_file>")}\n</attached_file>` } };
  }
  throw new AttachmentRejection(`${name}: attach images, text or code files${policy.documents ? ", or PDFs" : ""}.`);
}

function isTextFile(file: File, name: string): boolean {
  return file.type.startsWith("text/") || TEXT_TYPES.has(file.type) || TEXT_EXTENSIONS.has(extension(name));
}

function extension(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot < 0 ? "" : name.slice(dot + 1).toLowerCase();
}

function safeName(name: string): string {
  const clean = name.replace(/[\u0000-\u001f\u007f/\\]/g, "_").trim().slice(0, 200);
  return clean && clean !== "." && clean !== ".." ? clean : "Attachment";
}

function escapeAttribute(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function randomId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function readDataUrl(file: Blob, type?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new AttachmentRejection("The file could not be read."));
    reader.onload = () => {
      const value = String(reader.result);
      resolve(type ? value.replace(/^data:[^;,]*/, `data:${type}`) : value);
    };
    reader.readAsDataURL(file);
  });
}

/** Small images are sent unchanged; larger ones are downscaled to a bounded JPEG or PNG. */
async function imageDataUrl(file: File): Promise<string> {
  const bitmap = typeof createImageBitmap === "function"
    ? await createImageBitmap(file).catch(() => undefined) : undefined;
  if (!bitmap) {
    if (file.size <= MAX_INLINE_IMAGE_BYTES) return readDataUrl(file);
    throw new AttachmentRejection(`${file.name || "Image"} could not be decoded.`);
  }
  try {
    const scale = Math.min(1, MAX_IMAGE_EDGE / Math.max(bitmap.width, bitmap.height));
    if (scale === 1 && file.size <= MAX_INLINE_IMAGE_BYTES) return readDataUrl(file);
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext("2d");
    if (!context) return readDataUrl(file);
    const jpeg = () => {
      // JPEG has no alpha: composite transparent pixels onto white, not black.
      context.globalCompositeOperation = "source-over";
      context.fillStyle = "#fff";
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      return canvas.toDataURL("image/jpeg", 0.85);
    };
    if (file.type === "image/jpeg") return jpeg();
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const png = canvas.toDataURL("image/png");
    return png.length > MAX_INLINE_IMAGE_BYTES * 1.4 ? jpeg() : png;
  } finally {
    bitmap.close?.();
  }
}

export function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}
