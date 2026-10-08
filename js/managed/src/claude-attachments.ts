import type { PromptInput } from "nanocodex";

const IMAGE_ATTACHMENT_PREFIX = "Attached original image file.\n[Image attachment]\n";
const PREVIEW_PATH = /^\/brain\/attachments\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/preview\.jpg$/;
/** Conservative application bound shared with the portable Claude runtime. */
export const CLAUDE_INLINE_PREVIEW_MAX_BYTES = 5 * 1024 * 1024;
const MAX_INLINE_IMAGES = 20;
const MAX_INLINE_TOTAL_BYTES = 20 * 1024 * 1024;
const IMAGE_EXTENSIONS: Record<string, string> = {
  "image/jpeg": "jpg", "image/png": "png", "image/gif": "gif", "image/webp": "webp",
};
type Item = Exclude<PromptInput, string>[number];

/** Freeze supported originals into provider input; use the bounded JPEG for other
 * formats or oversized originals. Every unavailable image gets an explicit notice.
 * The caller persists this dispatch so replay never depends on mutable uploads. */
export async function inlineClaudeAttachmentPreviews(
  input: readonly Item[],
  load: (relativePath: string) => Promise<Uint8Array | undefined>,
): Promise<Item[]> {
  let count = input.filter((item) => item.type === "image").length;
  let total = input.reduce((bytes, item) => {
    const value = item.type === "file" ? item.file_data : item.type === "image" ? item.image_url : undefined;
    const data = value?.match(/^data:[^,]+;base64,(.*)$/)?.[1];
    return bytes + (data ? Math.floor(data.length * 3 / 4) - (data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0) : 0);
  }, 0);
  const output: Item[] = [];
  const unavailable = (reason: string) => output.push({ type: "text", text: `[Image attachment unavailable to Claude: ${reason}. The descriptor alone does not provide image content.]` });
  for (const item of input) {
    output.push(item);
    if (item.type !== "text" || !item.text.startsWith(IMAGE_ATTACHMENT_PREFIX)) continue;
    if (count >= MAX_INLINE_IMAGES) { unavailable("image count limit reached"); continue; }
    let header: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(item.text.slice(IMAGE_ATTACHMENT_PREFIX.length).split("\n", 1)[0] ?? "");
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
      header = parsed as Record<string, unknown>;
    } catch { unavailable("invalid attachment descriptor"); continue; }
    if (header.hand_id !== undefined) { unavailable("image is on a Hand; use that Hand's image tools to inspect it"); continue; }
    const match = typeof header.preview_path === "string" ? PREVIEW_PATH.exec(header.preview_path) : null;
    if (!match) { unavailable("invalid attachment path"); continue; }
    const directory = `attachments/${match[1]}`;
    const media = typeof header.media_type === "string" ? header.media_type : "";
    const extension = IMAGE_EXTENSIONS[media];
    let bytes: Uint8Array | undefined;
    let mime = media;
    const fits = (value: Uint8Array | undefined) => value && value.byteLength > 0
      && value.byteLength <= CLAUDE_INLINE_PREVIEW_MAX_BYTES && total + value.byteLength <= MAX_INLINE_TOTAL_BYTES;
    if (extension && header.path === `/brain/${directory}/original.${extension}`) {
      bytes = await load(`${directory}/original.${extension}`);
    }
    if (!fits(bytes) || imageType(bytes!) !== mime) {
      bytes = await load(`${directory}/preview.jpg`);
      mime = "image/jpeg";
    }
    if (!fits(bytes) || imageType(bytes!) !== mime) {
      unavailable("original and preview missing, invalid, or over the media limit"); continue;
    }
    total += bytes!.byteLength;
    count += 1;
    output.push({ type: "image", image_url: `data:${mime};base64,${base64(bytes!)}` });
  }
  return output;
}

function imageType(bytes: Uint8Array): string | undefined {
  const starts = (signature: number[]) => signature.every((value, index) => bytes[index] === value);
  if (starts([0xff, 0xd8, 0xff])) return "image/jpeg";
  if (starts([137, 80, 78, 71, 13, 10, 26, 10])) return "image/png";
  const ascii = (start: number, end: number) => String.fromCharCode(...bytes.subarray(start, end));
  if (["GIF87a", "GIF89a"].includes(ascii(0, 6))) return "image/gif";
  if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return "image/webp";
  return undefined;
}

function base64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  return btoa(binary);
}
