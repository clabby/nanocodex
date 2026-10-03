/** Managed image relay. Only the injected subscription broker can make requests. */
export type ManagedImageReference = { image_url: string } | { file_id: string };
export const MAX_MANAGED_EDIT_IMAGES = 5;
export const MAX_MANAGED_IMAGE_REFERENCE_BYTES = 20 * 1024 * 1024;
const FILE_ID = /^[A-Za-z0-9_-]{1,512}$/;
const DATA_IMAGE = /^data:image\/[A-Za-z0-9.+-]+;base64,[A-Za-z0-9+/]+={0,2}$/;
const SAFE_ID = /^[A-Za-z0-9_.:-]{1,256}$/;

export function managedImageReference(value: unknown): ManagedImageReference | undefined {
  if (typeof value === "string") value = { image_url: value };
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const ref = value as Record<string, unknown>;
  if (Object.keys(ref).length !== 1) return undefined;
  if (typeof ref.image_url === "string" && ref.image_url.length <= MAX_MANAGED_IMAGE_REFERENCE_BYTES
    && DATA_IMAGE.test(ref.image_url)) return { image_url: ref.image_url };
  if (typeof ref.file_id === "string" && ref.file_id.length <= 512 && FILE_ID.test(ref.file_id))
    return { file_id: ref.file_id };
  return undefined;
}

export function managedImageRequest(value: unknown): {
  path: "/v1/images/generations" | "/v1/images/edits";
  body: Record<string, unknown>;
} | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const args = value as Record<string, unknown>;
  if (Object.keys(args).some(key => !["images", "prompt", "transparent_background"].includes(key))
    || typeof args.prompt !== "string" || !args.prompt.trim()
    || (args.transparent_background !== undefined && typeof args.transparent_background !== "boolean")
    || (args.images !== undefined && !Array.isArray(args.images))) return undefined;
  const values = (args.images ?? []) as unknown[];
  if (values.length > MAX_MANAGED_EDIT_IMAGES) return undefined;
  const images: ManagedImageReference[] = [];
  for (const value of values) {
    const image = managedImageReference(value);
    if (!image) return undefined; // Never silently drop invalid edit targets.
    images.push(image);
  }
  return {
    path: images.length ? "/v1/images/edits" : "/v1/images/generations",
    body: {
      ...(images.length ? { images } : {}), prompt: args.prompt.trim(),
      background: args.transparent_background === true ? "transparent" : "opaque",
      model: "gpt-image-2", quality: "auto", size: "auto",
    },
  };
}

export function managedGeneratedImage(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const data = value as Record<string, unknown>;
  let ref = managedImageReference(Object.fromEntries(["image_url", "file_id"].flatMap(key =>
    data[key] === undefined ? [] : [[key, data[key]]])));
  if (!ref && data.image_url === undefined && data.file_id === undefined && typeof data.b64_json === "string")
    ref = managedImageReference({ image_url: `data:image/png;base64,${data.b64_json}` });
  if (!ref) return undefined;
  const result: Record<string, string> = { ...ref };
  for (const key of ["id", "asset_id", "generation_id"]) {
    const id = data[key];
    if (typeof id === "string" && SAFE_ID.test(id)) result[key] = id;
  }
  return result;
}

function safeId(value: unknown): string | undefined {
  return typeof value === "string" && SAFE_ID.test(value) ? value : undefined;
}

export function createManagedImageFetch(request: (
  path: "/v1/images/generations" | "/v1/images/edits", body: Record<string, unknown>,
) => Promise<Response>): typeof fetch {
  return async (input, init) => {
    let parsed: ReturnType<typeof managedImageRequest>;
    try { parsed = managedImageRequest(await new Request(input, init).json()); }
    catch { /* Malformed bodies are invalid, never a provider call. */ }
    if (!parsed) return Response.json({ error: "invalid managed image request" }, { status: 400 });
    let upstream: Response;
    try { upstream = await request(parsed.path, parsed.body); }
    catch { return Response.json({ error: "image generation request failed" }, { status: 502 }); }
    const requestId = safeId(upstream.headers.get("x-codex-imagegen-request-id"));
    let payload: unknown;
    try { payload = await upstream.json(); }
    catch {
      return Response.json({ error: "image generation returned an invalid response",
        ...(requestId ? { imagegen_request_id: requestId } : {}) }, { status: 502 });
    }
    const envelope = payload && typeof payload === "object" && !Array.isArray(payload)
      ? payload as Record<string, unknown> : undefined;
    const imagegenRequestId = requestId ?? safeId(envelope?.imagegen_request_id);
    const generationId = safeId(envelope?.generation_id);
    const ids = { ...(imagegenRequestId ? { imagegen_request_id: imagegenRequestId } : {}),
      ...(generationId ? { generation_id: generationId } : {}) };
    // Never relay provider error text, response bodies, URLs, or auth material.
    if (!upstream.ok) return Response.json({ error: `image generation failed: HTTP ${upstream.status}`, ...ids }, { status: 502 });
    const result = managedGeneratedImage(Array.isArray(envelope?.data) ? envelope.data[0] : envelope);
    return result ? Response.json({ ...result, ...ids })
      : Response.json({ error: "image generation returned no image", ...ids }, { status: 502 });
  };
}
