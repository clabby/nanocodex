import type { NamedTool, ToolContext } from "nanocodex";

/** Official OpenRouter video API (verified against https://openrouter.ai/openapi.json). */
export const OPENROUTER_API = "https://openrouter.ai/api/v1";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MODEL_ID = /^[a-z0-9][a-z0-9._-]{0,63}\/[a-z0-9][a-z0-9._:-]{0,127}$/i;
const JOB_ID = /^[A-Za-z0-9._:-]{1,160}$/;
const TERMINAL = new Set(["completed", "failed", "cancelled", "expired"]);
const CATALOG_TTL_MS = 5 * 60_000;
const MAX_JSON_BYTES = 4 * 1024 * 1024;
export const MAX_VIDEO_BYTES = 512 * 1024 * 1024;

export type VideoModel = {
  id: string; name?: string; description?: string;
  supported_durations?: number[] | null; supported_resolutions?: string[] | null;
  supported_aspect_ratios?: string[] | null; supported_sizes?: string[] | null;
  supported_frame_images?: string[] | null; generate_audio?: boolean | null; seed?: boolean | null;
  pricing_skus?: Record<string, string> | null; allowed_passthrough_parameters?: string[] | null;
};
type JobRow = {
  operation_id: string; fingerprint: string; model: string; state: string; job_id: string | null;
  job_status: string | null; error: string | null; outputs: number; cost: number | null; created_at: number; updated_at: number;
};
export type OpenRouterVideoOptions = Readonly<{
  /** Deployment secret; never returned, logged or accepted from tool input. */
  apiKey: string;
  db: D1Database;
  /** Authenticated account owner. Every receipt read and write is scoped to it. */
  owner: string;
  authorize: (context: ToolContext) => void;
  /** Writes a canonical /brain file for the current agent. */
  writeBrainFile: (path: string, body: ReadableStream, length: number, contentType: string) => Promise<void>;
  fetch?: typeof fetch;
  now?: () => number;
}>;

class VideoInputError extends Error {}
const fail = (message: string): never => { throw new VideoInputError(message); };

let catalogCache: { at: number; models: VideoModel[] } | undefined;

async function readJson(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) return undefined;
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_JSON_BYTES) { await reader.cancel(); throw new Error("oversized_response"); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  const text = new TextDecoder().decode(bytes);
  return text ? JSON.parse(text) : undefined;
}

/** Provider errors are bounded and never echo request headers or credentials. */
function upstreamMessage(value: unknown, apiKey: string): string | undefined {
  const raw = typeof value === "object" && value !== null
    ? (value as { error?: unknown }).error : undefined;
  const message = typeof raw === "string" ? raw
    : typeof raw === "object" && raw !== null && typeof (raw as { message?: unknown }).message === "string"
      ? (raw as { message: string }).message : undefined;
  if (!message) return undefined;
  return message.split(apiKey).join("[redacted]").replace(/[\u0000-\u001f]+/g, " ").slice(0, 500);
}

function stringList(value: unknown): string[] | null {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : null;
}

function projectModel(value: unknown): VideoModel | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const item = value as Record<string, unknown>;
  if (typeof item.id !== "string" || !MODEL_ID.test(item.id)) return undefined;
  const pricing = typeof item.pricing_skus === "object" && item.pricing_skus !== null
    ? Object.fromEntries(Object.entries(item.pricing_skus).filter(([, price]) => typeof price === "string")) as Record<string, string>
    : null;
  return {
    id: item.id,
    ...(typeof item.name === "string" ? { name: item.name.slice(0, 200) } : {}),
    ...(typeof item.description === "string" ? { description: item.description.slice(0, 400) } : {}),
    supported_durations: Array.isArray(item.supported_durations)
      ? item.supported_durations.filter((entry): entry is number => Number.isInteger(entry)) : null,
    supported_resolutions: stringList(item.supported_resolutions),
    supported_aspect_ratios: stringList(item.supported_aspect_ratios),
    supported_sizes: stringList(item.supported_sizes),
    supported_frame_images: stringList(item.supported_frame_images),
    generate_audio: typeof item.generate_audio === "boolean" ? item.generate_audio : null,
    seed: typeof item.seed === "boolean" ? item.seed : null,
    pricing_skus: pricing,
    allowed_passthrough_parameters: stringList(item.allowed_passthrough_parameters),
  };
}

function httpsUrl(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length > 4096) fail(`${label} must be an HTTPS URL`);
  let url: URL;
  try { url = new URL(value as string); } catch { return fail(`${label} must be an HTTPS URL`); }
  if (url.protocol !== "https:" || url.username || url.password) fail(`${label} must be an HTTPS URL without credentials`);
  return url.href;
}

function allowed<T>(value: T, list: readonly T[] | null | undefined, label: string, model: string): T {
  if (list && list.length > 0 && !list.includes(value)) fail(`${model} does not support ${label} ${String(value)}; supported: ${list.join(", ")}`);
  return value;
}

/** Validate against the live model catalog before any paid job can start. */
export function buildVideoRequest(input: Record<string, unknown>, model: VideoModel, previousJobId?: string): Record<string, unknown> {
  const body: Record<string, unknown> = { model: model.id };
  const frameImages = input.frame_images;
  if (input.prompt !== undefined) {
    if (typeof input.prompt !== "string" || !input.prompt.trim() || input.prompt.length > 10_000) fail("prompt must be 1-10000 characters");
    body.prompt = input.prompt;
  } else if (!Array.isArray(frameImages) || frameImages.length === 0) fail("prompt is required unless frame_images are supplied");
  if (input.duration !== undefined) {
    if (!Number.isInteger(input.duration) || (input.duration as number) < 1 || (input.duration as number) > 120) fail("duration must be an integer number of seconds");
    body.duration = allowed(input.duration as number, model.supported_durations, "duration", model.id);
  }
  if (input.size !== undefined) {
    if (input.resolution !== undefined || input.aspect_ratio !== undefined) fail("size replaces resolution and aspect_ratio; supply one form");
    if (typeof input.size !== "string" || !/^\d{2,5}x\d{2,5}$/.test(input.size)) fail("size must be WIDTHxHEIGHT");
    body.size = allowed(input.size as string, model.supported_sizes, "size", model.id);
  }
  if (input.resolution !== undefined) {
    if (typeof input.resolution !== "string") fail("resolution must be a string");
    body.resolution = allowed(input.resolution as string, model.supported_resolutions, "resolution", model.id);
  }
  if (input.aspect_ratio !== undefined) {
    if (typeof input.aspect_ratio !== "string") fail("aspect_ratio must be a string");
    body.aspect_ratio = allowed(input.aspect_ratio as string, model.supported_aspect_ratios, "aspect_ratio", model.id);
  }
  if (input.generate_audio !== undefined) {
    if (typeof input.generate_audio !== "boolean") fail("generate_audio must be boolean");
    if (input.generate_audio && model.generate_audio !== true) fail(`${model.id} does not support generate_audio`);
    body.generate_audio = input.generate_audio;
  }
  if (input.seed !== undefined) {
    if (!Number.isInteger(input.seed) || (input.seed as number) < 0 || (input.seed as number) > 4_294_967_295) fail("seed must be a non-negative 32-bit integer");
    if (model.seed !== true) fail(`${model.id} does not support seed`);
    body.seed = input.seed;
  }
  if (frameImages !== undefined) {
    if (!Array.isArray(frameImages) || frameImages.length < 1 || frameImages.length > 2) fail("frame_images must contain one or two images");
    const seen = new Set<string>();
    body.frame_images = (frameImages as unknown[]).map((item, index) => {
      const frame = (typeof item === "object" && item !== null ? item : {}) as Record<string, unknown>;
      if (frame.frame_type !== "first_frame" && frame.frame_type !== "last_frame") fail(`frame_images[${index}].frame_type must be first_frame or last_frame`);
      const type = frame.frame_type as string;
      if (seen.has(type)) fail(`frame_images repeats ${type}`);
      seen.add(type);
      if (!model.supported_frame_images?.includes(type)) fail(`${model.id} does not support ${type} frame images`);
      return { type: "image_url", image_url: { url: httpsUrl(frame.url, `frame_images[${index}].url`) }, frame_type: type };
    });
  }
  if (input.input_references !== undefined) {
    if (!Array.isArray(input.input_references) || input.input_references.length < 1 || input.input_references.length > 9) fail("input_references must contain 1-9 references");
    body.input_references = (input.input_references as unknown[]).map((item, index) => {
      const reference = (typeof item === "object" && item !== null ? item : {}) as Record<string, unknown>;
      const kind = reference.type;
      if (kind !== "image" && kind !== "video" && kind !== "audio") fail(`input_references[${index}].type must be image, video or audio`);
      const key = `${kind as string}_url`;
      return { type: key, [key]: { url: httpsUrl(reference.url, `input_references[${index}].url`) } };
    });
  }
  if (previousJobId !== undefined) body.previous_job_id = previousJobId;
  return body;
}

async function fingerprint(value: unknown): Promise<string> {
  const canonical = (item: unknown): unknown => Array.isArray(item) ? item.map(canonical)
    : typeof item === "object" && item !== null
      ? Object.fromEntries(Object.keys(item).sort().map(key => [key, canonical((item as Record<string, unknown>)[key])]))
      : item;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(canonical(value))));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

type Freshness = { status_source: "provider" | "durable_terminal" | "durable_receipt" | "stale_receipt"; stale?: true; refresh_error?: string; status_as_of?: number };

export const UNKNOWN_LENGTH_MAX_BYTES = 96 * 1024 * 1024;

/** Reads a stream into memory, cancelling and returning undefined once more than `limit` bytes arrive. */
export async function readBounded(stream: ReadableStream<Uint8Array>, limit: number): Promise<Uint8Array | undefined> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) { await reader.cancel().catch(() => undefined); return undefined; }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.byteLength; }
  return out;
}

function receipt(row: JobRow) {
  const state = row.state === "submitting" ? "outcome_unknown" : row.state;
  return {
    operation_id: row.operation_id, model: row.model, state,
    ...(row.job_status ? { status: row.job_status } : {}),
    ...(row.outputs ? { outputs: row.outputs } : {}),
    ...(row.cost !== null ? { cost_usd: row.cost } : {}),
    ...(row.error ? { error: row.error } : {}),
    ...(state === "outcome_unknown" ? { note: "The submission may have started. Do not resubmit under a new operation_id unless you accept a possible duplicate charge." } : {}),
  };
}

export function createOpenRouterVideoTool(options: OpenRouterVideoOptions): NamedTool {
  const send = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  const db = options.db;
  const headers = { authorization: `Bearer ${options.apiKey}` };
  const api = (path: string, init: RequestInit = {}, signal?: AbortSignal) =>
    send(`${OPENROUTER_API}${path}`, { ...init, redirect: "manual", signal, headers: { ...headers, ...(init.headers as Record<string, string> | undefined) } });

  async function catalog(signal: AbortSignal, refresh = false): Promise<VideoModel[]> {
    if (!refresh && catalogCache && now() - catalogCache.at < CATALOG_TTL_MS) return catalogCache.models;
    const response = await api("/videos/models", {}, signal);
    if (!response.ok) { await response.body?.cancel(); throw new Error(`openrouter_catalog_unavailable:${response.status}`); }
    const data = (await readJson(response) as { data?: unknown })?.data;
    if (!Array.isArray(data)) throw new Error("openrouter_catalog_unavailable");
    const models = data.map(projectModel).filter((model): model is VideoModel => model !== undefined);
    catalogCache = { at: now(), models };
    return models;
  }
  const row = (operationId: string) => db.prepare(
    "SELECT operation_id,fingerprint,model,state,job_id,job_status,error,outputs,cost,created_at,updated_at FROM openrouter_video_jobs WHERE owner_id=? AND operation_id=?",
  ).bind(options.owner, operationId).first<JobRow>();
  const operationId = (value: unknown, key = "operation_id") => {
    if (typeof value !== "string" || !UUID.test(value)) fail(`${key} must be a UUID`);
    return (value as string).toLowerCase();
  };
  async function owned(id: string): Promise<JobRow> {
    const found = await row(id);
    if (!found) fail("unknown operation_id for this account");
    return found!;
  }

  // Returns the durable row plus explicit freshness: a failed provider poll never masquerades as current status.
  async function refresh(job: JobRow, signal: AbortSignal): Promise<{ job: JobRow; freshness: Freshness }> {
    if (!job.job_id) return { job, freshness: { status_source: "durable_receipt" } };
    if (job.job_status && TERMINAL.has(job.job_status)) return { job, freshness: { status_source: "durable_terminal" } };
    const stale = (reason: string): { job: JobRow; freshness: Freshness } => ({ job, freshness: { status_source: "stale_receipt", stale: true, refresh_error: reason, status_as_of: job.updated_at } });
    let response: Response;
    try { response = await api(`/videos/${encodeURIComponent(job.job_id)}`, {}, signal); } catch (error) {
      if (signal.aborted) throw error;
      return stale("openrouter_status_unreachable");
    }
    const data = await readJson(response).catch(() => undefined) as Record<string, unknown> | undefined;
    if (!response.ok) return stale(`openrouter_status_${response.status}`);
    if (!data || typeof data.status !== "string") return stale("openrouter_status_malformed");
    const urls = Array.isArray(data.unsigned_urls) ? data.unsigned_urls.length : 0;
    const usage = data.usage as { cost?: unknown } | undefined;
    const updated: JobRow = { ...job, job_status: data.status.slice(0, 32), outputs: urls,
      cost: typeof usage?.cost === "number" ? usage.cost : job.cost,
      error: typeof data.error === "string" ? data.error.split(options.apiKey).join("[redacted]").slice(0, 500) : job.error, updated_at: now() };
    await db.prepare("UPDATE openrouter_video_jobs SET job_status=?,outputs=?,cost=?,error=?,updated_at=? WHERE owner_id=? AND operation_id=?")
      .bind(updated.job_status, updated.outputs, updated.cost, updated.error, updated.updated_at, options.owner, job.operation_id).run();
    return { job: updated, freshness: { status_source: "provider" } };
  }

  async function submit(input: Record<string, unknown>, signal: AbortSignal) {
    const id = operationId(input.operation_id);
    if (typeof input.model !== "string" || !MODEL_ID.test(input.model)) fail("model must be an OpenRouter video model id");
    // A durable receipt with the same arguments returns without consulting the provider.
    const existing = await row(id);
    let previousJobId: string | undefined;
    if (input.previous_operation_id !== undefined) {
      const previous = await owned(operationId(input.previous_operation_id, "previous_operation_id"));
      if (!previous.job_id || previous.job_status !== "completed") fail("previous_operation_id must name a completed job");
      if (previous.model !== input.model) fail("previous_operation_id must use the same model");
      previousJobId = previous.job_id!;
    }
    const intent = { ...input, operation_id: id };
    const print = await fingerprint(intent);
    if (existing) {
      if (existing.fingerprint !== print) fail("operation_id was already used with different arguments");
      return { ...receipt(existing), replayed: true };
    }
    const model = (await catalog(signal)).find(item => item.id === input.model)
      ?? (await catalog(signal, true)).find(item => item.id === input.model);
    if (!model) fail(`${input.model as string} is not in the live OpenRouter video catalog`);
    const body = { ...buildVideoRequest(input, model!, previousJobId), session_id: id };
    const created = now();
    const reserved = await db.prepare(
      "INSERT INTO openrouter_video_jobs (owner_id,operation_id,fingerprint,model,state,outputs,created_at,updated_at) VALUES (?,?,?,?, 'submitting',0,?,?) ON CONFLICT DO NOTHING",
    ).bind(options.owner, id, print, model!.id, created, created).run();
    if (!reserved.meta.changes) {
      const raced = await owned(id);
      if (raced.fingerprint !== print) fail("operation_id was already used with different arguments");
      return { ...receipt(raced), replayed: true };
    }
    const settle = async (state: string, fields: { job_id?: string; job_status?: string; error?: string }) => {
      await db.prepare("UPDATE openrouter_video_jobs SET state=?,job_id=?,job_status=?,error=?,updated_at=? WHERE owner_id=? AND operation_id=? AND state='submitting'")
        .bind(state, fields.job_id ?? null, fields.job_status ?? null, fields.error ?? null, now(), options.owner, id).run();
      return receipt(await owned(id));
    };
    let response: Response;
    try {
      response = await api("/videos", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }, signal);
    } catch { return settle("outcome_unknown", {}); }
    const data = await readJson(response).catch(() => undefined) as Record<string, unknown> | undefined;
    if (response.ok && typeof data?.id === "string" && JOB_ID.test(data.id)) {
      return settle("submitted", { job_id: data.id, job_status: typeof data.status === "string" ? data.status.slice(0, 32) : "pending" });
    }
    // Definite client-side rejections create no job. Other replies are ambiguous.
    if ([400, 401, 402, 403, 404, 413, 422, 429].includes(response.status)) {
      return settle("rejected", { error: `openrouter_${response.status}${upstreamMessage(data, options.apiKey) ? `: ${upstreamMessage(data, options.apiKey)}` : ""}` });
    }
    return settle("outcome_unknown", { error: `openrouter_${response.status}` });
  }

  async function download(input: Record<string, unknown>, signal: AbortSignal) {
    const id = operationId(input.operation_id);
    const { job, freshness } = await refresh(await owned(id), signal);
    if (!job.job_id || job.job_status !== "completed") return { ...receipt(job), ...freshness, error: freshness.refresh_error ?? job.error ?? "video is not completed" };
    const index = input.index === undefined ? 0 : input.index;
    if (!Number.isInteger(index) || (index as number) < 0 || (job.outputs > 0 && (index as number) >= job.outputs)) fail("index is outside the generated outputs");
    const path = input.path === undefined ? `/brain/outputs/videos/${id}${index ? `-${index}` : ""}.mp4` : input.path;
    if (typeof path !== "string" || path.length > 512 || !/^\/brain\/(?:[A-Za-z0-9._ -]+\/)*[A-Za-z0-9._ -]+\.mp4$/.test(path)
      || path.split("/").some(part => part === "." || part === "..")) fail("path must be a canonical /brain/... .mp4 file");
    let response = await api(`/videos/${encodeURIComponent(job.job_id)}/content?index=${index as number}`, {}, signal);
    if (response.status >= 300 && response.status < 400) {
      // Provider storage redirects never receive the deployment credential.
      const location = response.headers.get("location");
      await response.body?.cancel();
      if (!location) return { ...receipt(job), error: "openrouter_content_redirect_invalid" };
      const target = httpsUrl(new URL(location, OPENROUTER_API).href, "content redirect");
      response = await send(target, { redirect: "follow", signal });
    }
    if (!response.ok || !response.body) { await response.body?.cancel(); return { ...receipt(job), error: `openrouter_content_${response.status}` }; }
    const contentType = (response.headers.get("content-type") ?? "video/mp4").split(";")[0]!.trim();
    if (!/^video\/|^application\/octet-stream$/.test(contentType)) { await response.body.cancel(); return { ...receipt(job), error: "openrouter_content_not_video" }; }
    const length = Number(response.headers.get("content-length"));
    let body: ReadableStream, size: number;
    if (Number.isSafeInteger(length) && length > 0) {
      if (length > MAX_VIDEO_BYTES) { await response.body.cancel(); return { ...receipt(job), error: "video exceeds 512 MiB" }; }
      const fixed = new FixedLengthStream(length);
      void response.body.pipeTo(fixed.writable).catch(() => undefined);
      body = fixed.readable; size = length;
    } else {
      // Without a declared length, buffer at most UNKNOWN_LENGTH_MAX_BYTES and abort as soon as the cap is crossed.
      const bytes = await readBounded(response.body, UNKNOWN_LENGTH_MAX_BYTES);
      if (!bytes) return { ...receipt(job), error: `video without content-length exceeds ${UNKNOWN_LENGTH_MAX_BYTES / (1024 * 1024)} MiB` };
      if (bytes.byteLength === 0) return { ...receipt(job), error: "video body is empty" };
      body = new Blob([bytes]).stream(); size = bytes.byteLength;
    }
    await options.writeBrainFile(path as string, body, size, contentType === "application/octet-stream" ? "video/mp4" : contentType);
    return { ...receipt(job), path, bytes: size, content_type: contentType };
  }

  return {
    name: "openrouter_video",
    description: "Generate video clips with OpenRouter video models such as ByteDance Seedance, using the platform's server-side OpenRouter key. Operations: models (live catalog with supported durations, resolutions, aspect ratios, sizes, frame images, audio, seed and pricing; optional q filter), submit (starts one paid job; requires a stable UUID operation_id and validates every option against the live catalog), status (poll by operation_id), download (save a completed clip to /brain, default /brain/outputs/videos/<operation_id>.mp4). Jobs belong to this account and are addressed only by operation_id. Reuse the same operation_id and identical arguments after an uncertain result; never resubmit under a new ID, which can start a duplicate paid job. Generation usually takes minutes; poll status before download. frame_images and input_references take public HTTPS URLs.",
    parameters: {
      type: "object", additionalProperties: false, required: ["operation"], properties: {
        operation: { type: "string", enum: ["models", "submit", "status", "download"] },
        q: { type: "string", maxLength: 100, description: "models: case-insensitive id/name filter, such as seedance." },
        operation_id: { type: "string", description: "Stable UUID for submit, or the submitted operation for status/download." },
        model: { type: "string", description: "Exact video model id from models, such as bytedance/seedance-2.0." },
        prompt: { type: "string", maxLength: 10000 },
        duration: { type: "integer", minimum: 1, description: "Seconds; must be one of the model's supported_durations." },
        resolution: { type: "string" }, aspect_ratio: { type: "string" },
        size: { type: "string", description: "WIDTHxHEIGHT; replaces resolution and aspect_ratio." },
        generate_audio: { type: "boolean" }, seed: { type: "integer", minimum: 0 },
        frame_images: { type: "array", maxItems: 2, items: { type: "object", additionalProperties: false, required: ["frame_type", "url"],
          properties: { frame_type: { type: "string", enum: ["first_frame", "last_frame"] }, url: { type: "string" } } } },
        input_references: { type: "array", maxItems: 9, items: { type: "object", additionalProperties: false, required: ["type", "url"],
          properties: { type: { type: "string", enum: ["image", "video", "audio"] }, url: { type: "string" } } } },
        previous_operation_id: { type: "string", description: "submit: completed operation to extend or edit, for models that support continuation." },
        index: { type: "integer", minimum: 0, description: "download: output index, default 0." },
        path: { type: "string", description: "download: destination /brain/... .mp4 path." },
      },
    },
    handler: async (input, context) => {
      options.authorize(context);
      const value = (typeof input === "object" && input !== null ? input : {}) as Record<string, unknown>;
      const signal = context.signal;
      try {
        switch (value.operation) {
          case "models": {
            if (value.q !== undefined && (typeof value.q !== "string" || value.q.length > 100)) fail("q must be a short string");
            const q = typeof value.q === "string" ? value.q.toLowerCase() : "";
            const models = (await catalog(signal)).filter(model => !q || model.id.toLowerCase().includes(q) || model.name?.toLowerCase().includes(q));
            return { models: models.slice(0, 50), truncated: models.length > 50 };
          }
          case "submit": {
            const { operation: _operation, ...rest } = value;
            return await submit(rest, signal);
          }
          case "status": {
            const { job, freshness } = await refresh(await owned(operationId(value.operation_id)), signal);
            return { ...receipt(job), ...freshness };
          }
          case "download": return await download(value, signal);
          default: return fail("operation must be models, submit, status or download");
        }
      } catch (error) {
        if (error instanceof VideoInputError) return { error: "invalid_request", message: error.message };
        if (signal.aborted) throw error;
        const message = error instanceof Error && error.message.startsWith("openrouter_") ? error.message : "openrouter_video_unavailable";
        return { error: message };
      }
    },
  };
}
