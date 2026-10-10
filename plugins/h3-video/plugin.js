// Derived from 88API's Minimax-H3 task plugin for NewAPI / QuantumNous.
// SPDX-License-Identifier: AGPL-3.0-or-later
// This is a separate driver: existing Minimax-H3 channels and persisted tasks are untouched.
//
// The upstream owns every capability (resolutions, ratios, durations, media
// limits, workflow combinations) and rejects invalid requests before creating a
// task; 768P 3:2/2:3 is the one combination checked locally (see outputFor).
// This driver only translates fields and guarantees that the billed
// seconds and resolution are exactly the values sent upstream.
const RESOLUTIONS = ["480p", "768p", "1080p", "2k", "4k"];

export const meta = {
  apiVersion: 1,
  key: "h3-video",
  name: "H3-Video",
  description: { en: "MiniMax H3 video integration", zh: "MiniMax H3 视频集成" },
  version: "1.0.3",
  author: { name: "88API" },
  models: [],
  dynamicModels: true,
  fetchMode: "per_task",
  protocols: ["openai_video"],
  usageSchema: {
    seconds: {
      type: "number",
      unit: "second",
      description: { en: "Video generation unit price", zh: "视频生成单价" },
    },
    // Upstream per-second price tiers; a new upstream tier needs a plugin update and pricing.
    resolution: {
      enum: RESOLUTIONS,
      // 2K/4K come from the upstream upscaling workflows, not native generation.
      enumLabels: Object.fromEntries(RESOLUTIONS.map(function (value) {
        const name = value.toUpperCase();
        if (value !== "2k" && value !== "4k") return [value, { en: name, zh: name }];
        return [value, { en: name + " (upscaled)", zh: name + "（超分）" }];
      })),
      description: { en: "Output video resolution", zh: "输出视频分辨率" },
    },
  },
};

// Used only when the request omits them: the upstream catalogue's first output.
const DEFAULT_RESOLUTION = "480p";
const DEFAULT_RATIO = "16x9";
const DEFAULT_DURATION = 5;
// Host billing bound (relaycommon.MaxTaskDurationSeconds), not an upstream capability.
const MAX_BILLABLE_SECONDS = 3600;
// The upstream reports completed before its CDN link exists. Keep polling a
// bounded number of rounds instead of exposing the credentialed site route.
const MAX_LINK_WAIT_POLLS = 60;
const CONSUMED_METADATA = [
  "duration", "seconds", "resolution", "ratio", "aspect_ratio", "aspectRatio", "size", "output", "workflow_id",
  "content", "first_frame_image", "firstFrame", "first_image", "last_frame_image", "lastFrame", "last_image",
  "reference_images", "referenceImages", "reference_image", "reference_videos", "referenceVideos", "reference_video",
  "reference_audios", "referenceAudios", "reference_audio",
];

function trimmed(value) {
  return typeof value === "string" ? value.trim() : "";
}

function object(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function present(value) {
  return value !== undefined && value !== null && value !== "";
}

function normalizedBaseUrl(value) {
  const baseUrl = trimmed(value).replace(/\/+$/, "").replace(/\/(?:draw\/api\/)?v1$/, "");
  if (!baseUrl) throw new Error("视频服务尚未配置访问地址，请联系管理员。");
  return baseUrl;
}

function asArray(value) {
  if (!present(value)) return [];
  return Array.isArray(value) ? value : [value];
}

function firstValues() {
  for (const value of arguments) {
    // Keep empty entries so mediaURL reports them instead of silently dropping media.
    const values = asArray(value).filter(function (item) { return item !== undefined && item !== null; });
    if (values.length) return values;
  }
  return [];
}

function metadataFor(req) {
  if (!present(req.metadata)) return {};
  if (typeof req.metadata !== "object" || Array.isArray(req.metadata)) throw new Error("metadata 参数必须为 JSON 对象。");
  return req.metadata;
}

// The single value that is both sent upstream and billed. Conflicting aliases are rejected.
function agreed(values, label, normalize) {
  let selected;
  for (const value of values) {
    if (!present(value)) continue;
    const normalized = normalize(value);
    if (selected !== undefined && normalized !== selected) throw new Error(label + "参数不一致，请只提供一个值。");
    selected = normalized;
  }
  return selected;
}

function secondsValue(value) {
  if ((typeof value !== "number" && typeof value !== "string") || !/^\s*\d+\s*$/.test(String(value))) {
    throw new Error("视频时长必须是正整数秒数。");
  }
  const seconds = Number(value);
  if (!Number.isSafeInteger(seconds) || seconds < 1 || seconds > MAX_BILLABLE_SECONDS) throw new Error("视频时长必须是正整数秒数。");
  return seconds;
}

function resolutionValue(value) {
  const resolution = trimmed(String(value)).toLowerCase();
  if (!resolution) throw new Error("分辨率不能为空。");
  return resolution;
}

function ratioValue(value) {
  const ratio = trimmed(String(value)).toLowerCase().replace(":", "x");
  if (!ratio) throw new Error("画幅比例不能为空。");
  return ratio;
}

function greatestCommonDivisor(a, b) {
  return b ? greatestCommonDivisor(b, a % b) : a;
}

// size is either a resolution tier ("1080p", "2k") or width x height.
function sizeParts(size) {
  const value = trimmed(String(size || "")).toLowerCase();
  if (!value) return {};
  const dimensions = /^(\d+)x(\d+)$/.exec(value);
  if (!dimensions) return { resolution: value };
  const width = Number(dimensions[1]);
  const height = Number(dimensions[2]);
  if (!width || !height) throw new Error("视频尺寸必须为正整数。");
  const divisor = greatestCommonDivisor(width, height);
  const ratio = width / divisor + "x" + height / divisor;
  return { ratio: ratio === "7x3" ? "21x9" : ratio === "3x7" ? "9x21" : ratio };
}

function outputParts(output) {
  const ratio = trimmed(object(output).ratio).toLowerCase();
  if (!ratio) return {};
  const match = /^([^-]+)-(.+)$/.exec(ratio);
  if (!match) throw new Error("output.ratio 格式不正确，例如 1080p-16x9。");
  return { resolution: match[1], ratio: match[2] };
}

function outputFor(req, metadata) {
  const output = outputParts(present(req.output) ? req.output : metadata.output);
  const size = sizeParts(present(req.size) ? req.size : metadata.size);
  const resolution = agreed([req.resolution, metadata.resolution, size.resolution, output.resolution], "分辨率", resolutionValue) || DEFAULT_RESOLUTION;
  const ratio = agreed([req.ratio, req.aspect_ratio, req.aspectRatio, metadata.ratio, metadata.aspect_ratio, metadata.aspectRatio, size.ratio, output.ratio], "画幅比例", ratioValue) || DEFAULT_RATIO;
  // The upstream answers this combination with a generic "retry later" error instead of a parameter error.
  if (resolution === "768p" && (ratio === "3x2" || ratio === "2x3")) {
    throw new Error("768P 不支持 3:2 / 2:3 比例，请改用其他比例或分辨率。");
  }
  return { resolution: resolution, ratio: resolution + "-" + ratio };
}

function mediaURL(value) {
  if (typeof value === "string") {
    if (!value.trim()) throw new Error("素材地址不能为空，请提供有效的素材链接。");
    return value.trim();
  }
  const item = object(value);
  if (present(item.url)) return mediaURL(item.url);
  // Uploaded files stay host-owned; the host inlines them as data URLs.
  if (typeof item.__fileRef === "string" && item.__fileRef) return { __fileRef: item.__fileRef, encoding: "dataUrl" };
  throw new Error("素材格式不正确，请提供素材链接或有效的上传文件。");
}

function reference(type, role, value) {
  return { type: type, role: role, url: mediaURL(value) };
}

const CONTENT_TYPES = { image_url: "image", video_url: "video", audio_url: "audio" };
const CONTENT_ROLES = { first_frame: "first_frame", last_frame: "last_frame" };

function contentReference(item) {
  const entry = object(item);
  const role = trimmed(entry.role);
  const type = CONTENT_TYPES[entry.type] || CONTENT_TYPES[{ reference_image: "image_url", first_frame: "image_url", last_frame: "image_url", reference_video: "video_url", reference_audio: "audio_url" }[role || trimmed(entry.type)]];
  if (!type) throw new Error("不支持该素材类型，请使用文本、图片、视频或音频。");
  const value = present(entry[type + "_url"]) ? entry[type + "_url"] : present(entry.url) ? entry.url : entry.uri;
  return reference(type, CONTENT_ROLES[role] || CONTENT_ROLES[trimmed(entry.type)] || "reference", value);
}

// Collect every media source; the upstream validates counts, types and combinations.
function referencesFor(req, metadata) {
  const references = [];
  let prompt = trimmed(req.prompt);
  for (const item of asArray(present(metadata.content) ? metadata.content : req.content).concat(asArray(req.media))) {
    if (object(item).type === "text") {
      const text = trimmed(item.text);
      if (prompt && text && text !== prompt) throw new Error("请只提供一段提示词。");
      prompt = prompt || text;
      continue;
    }
    references.push(contentReference(item));
  }
  for (const item of asArray(req.references)) {
    const entry = object(item);
    if (!trimmed(entry.type)) throw new Error("references 中的素材需要填写 type。");
    // Upstream format is forwarded as-is apart from the media value itself.
    references.push(Object.assign({}, entry, { role: trimmed(entry.role) || "reference", url: mediaURL(entry.url) }));
  }
  const firstFrame = firstValues(metadata.first_frame_image, metadata.firstFrame, metadata.first_image);
  const lastFrame = firstValues(metadata.last_frame_image, metadata.lastFrame, metadata.last_image);
  const frames = firstValues(req.images, req.image, req.input_reference);
  if (firstFrame.length || lastFrame.length) {
    for (const value of firstFrame) references.push(reference("image", "first_frame", value));
    for (const value of lastFrame) references.push(reference("image", "last_frame", value));
    for (const value of frames) references.push(reference("image", "reference", value));
  } else {
    // Previous Minimax-H3 convention: images[0] is the first frame, images[1] the last frame.
    frames.forEach(function (value, index) {
      references.push(reference("image", index === 0 ? "first_frame" : index === 1 ? "last_frame" : "reference", value));
    });
  }
  for (const value of firstValues(metadata.reference_images, metadata.referenceImages, metadata.reference_image)) references.push(reference("image", "reference", value));
  for (const value of firstValues(req.videos, req.video, metadata.reference_videos, metadata.referenceVideos, metadata.reference_video)) references.push(reference("video", "reference", value));
  for (const value of firstValues(req.audios, req.audio, metadata.reference_audios, metadata.referenceAudios, metadata.reference_audio)) references.push(reference("audio", "reference", value));
  return { prompt: prompt, references: references };
}

// Convenience default only; an explicit workflow_id is forwarded unchanged.
function defaultWorkflow(resolution, references) {
  const superResolution = resolution === "2k" || resolution === "4k";
  if (references.some(function (item) { return item.role === "first_frame" || item.role === "last_frame"; })) {
    return superResolution ? "cf-fl2v" : "fl2v";
  }
  if (references.length || superResolution) return superResolution ? "cf-multi-reference" : "multi-reference";
  return "text-to-video";
}

function normalizedRequest(ctx) {
  const req = ctx.requestBody || {};
  const metadata = metadataFor(req);
  const output = outputFor(req, metadata);
  const media = referencesFor(req, metadata);
  const workflow = agreed([req.workflow_id, metadata.workflow_id], "workflow_id", trimmed) || defaultWorkflow(output.resolution, media.references);
  // Unconsumed metadata (prompt_enhance, seed, ...) is forwarded for the upstream to accept or ignore.
  const extras = {};
  for (const name of Object.keys(metadata)) {
    if (!CONSUMED_METADATA.includes(name)) extras[name] = metadata[name];
  }
  const body = {};
  if (present(req.prompt_enhance)) body.prompt_enhance = req.prompt_enhance === "true" ? true : req.prompt_enhance === "false" ? false : req.prompt_enhance;
  Object.assign(body, {
    model: trimmed(ctx.upstreamModel) || trimmed(ctx.model),
    prompt: media.prompt,
    seconds: agreed([req.duration, req.seconds, metadata.duration, metadata.seconds], "视频时长", secondsValue) || DEFAULT_DURATION,
    workflow_id: workflow,
    output: { ratio: output.ratio },
  });
  if (!body.prompt) delete body.prompt;
  if (media.references.length) body.references = media.references;
  return { body: body, extras: extras, resolution: output.resolution };
}

function actionFor(body) {
  const references = body.references || [];
  if (!references.length) return "text_to_video";
  return references.some(function (item) { return item.role !== "first_frame" && item.role !== "last_frame"; }) ? "reference_to_video" : "image_to_video";
}

export function buildSubmitRequest(ctx) {
  const request = normalizedRequest(ctx);
  const body = Object.assign({}, request.extras, request.body);
  const headers = { "Content-Type": "application/json", Accept: "application/json", Authorization: "Bearer " + ctx.apiKey };
  // The upstream deduplicates by Idempotency-Key, so host retries reuse one generation.
  const idempotencyKey = trimmed(ctx.publicTaskId);
  if (/^[A-Za-z0-9._:-]{8,128}$/.test(idempotencyKey)) headers["Idempotency-Key"] = idempotencyKey;
  return { url: normalizedBaseUrl(ctx.baseUrl) + "/v1/videos", method: "POST", headers: headers, body: body, action: actionFor(body) };
}

export function extractUsage(ctx) {
  if (ctx.usagePurpose === "billing_ratios") return null;
  const request = normalizedRequest(ctx);
  return { seconds: request.body.seconds, resolution: request.resolution };
}

export function extractUsageOnComplete() {
  // The query response has no billed duration; keep the frozen, validated request facts.
  return null;
}

function apiErrorMessage(body) {
  const error = object(object(body).error);
  const message = trimmed(error.message);
  const code = trimmed(error.code) || trimmed(error.type);
  if (message) return code ? code + ": " + message : message;
  return code;
}

function taskBody(data) {
  const source = object(data);
  return object(source.data).id || object(source.data).status ? object(source.data) : source;
}

// Only an off-site link is usable without the channel key; the site's own
// /content route needs Authorization and redirects cross-origin to the CDN.
function directVideoURL(body) {
  for (const value of [body.video_url, object(body.content).video_url, body.url]) {
    const url = trimmed(value);
    if (/^https?:\/\//i.test(url) && !/\/videos\/[^/?#]+\/content(?:[?#]|$)/.test(url)) return url;
  }
  return "";
}

// Failure reasons are shown to end users: drop links and host names that would identify the upstream.
function publicReason(message) {
  return trimmed(String(message || "")
    .replace(/[a-z][a-z0-9+.-]*:\/\/\S+/gi, "")
    .replace(/\b(?:[a-z0-9-]+\.)+(?:com|net|org|best|cn|io|ai|cc|top|xyz|dev|app|co|me|info|site|online|tech|cloud)\b\S*/gi, "")
    .replace(/\s{2,}/g, " "));
}

function failureReason(body) {
  return publicReason(apiErrorMessage(body) || trimmed(body.status_message)) || "视频生成失败，服务端未提供具体原因，请联系管理员。";
}

export function parseSubmitResponse(_ctx, response) {
  const body = object(response.body);
  const taskId = trimmed(body.id) || trimmed(body.task_id);
  if (!taskId) {
    throw new Error(publicReason(apiErrorMessage(body)) || "视频服务未返回任务编号，请联系管理员确认是否已受理，勿重复提交。");
  }
  const result = { taskId: taskId, taskData: body };
  if (body.status === "failed") result.immediate = { status: "FAILURE", progress: "100%", reason: failureReason(body) };
  return result;
}

export function buildQueryRequest(ctx) {
  if (!trimmed(ctx.taskId)) throw new Error("缺少视频任务编号。");
  return {
    url: normalizedBaseUrl(ctx.baseUrl) + "/v1/videos/" + encodeURIComponent(ctx.taskId),
    method: "GET",
    headers: { Accept: "application/json", Authorization: "Bearer " + ctx.apiKey },
  };
}

function stageProgress(value) {
  const progress = Number(value);
  if (!Number.isFinite(progress)) return 0;
  return Math.min(99, Math.max(0, Math.floor(progress)));
}

export function parseTaskResult(ctx, data) {
  const body = taskBody(data);
  if (!body.status) {
    return { status: "UNKNOWN", reason: publicReason(apiErrorMessage(body)) || "暂未获取到视频任务信息，请稍后查询，无需重新提交生成。" };
  }
  const id = trimmed(body.id) || trimmed(body.task_id);
  if (trimmed(ctx && ctx.taskId) && id && id !== ctx.taskId) throw new Error("上游返回的任务编号不匹配。");
  if (body.status === "queued") return { status: "QUEUED", progress: stageProgress(body.progress) + "%" };
  if (body.status === "in_progress") return { status: "IN_PROGRESS", progress: Math.max(1, stageProgress(body.progress)) + "%" };
  if (body.status === "failed") return { status: "FAILURE", progress: "100%", reason: failureReason(body) };
  if (body.status !== "completed") {
    return { status: "UNKNOWN", reason: "暂时无法识别视频任务状态，请稍后查询，无需重新提交生成。" };
  }
  const url = directVideoURL(body);
  if (url) return { status: "SUCCESS", progress: "100%", url: url };
  const waited = Number(object(ctx && ctx.state).linkWaitPolls) || 0;
  if (waited >= MAX_LINK_WAIT_POLLS) {
    return { status: "FAILURE", progress: "100%", reason: "视频已生成，但成品链接长时间未就绪，请联系管理员处理。" };
  }
  return { status: "IN_PROGRESS", progress: "99%", state: { linkWaitPolls: waited + 1 } };
}

export function listArtifacts(task) {
  if (task.status !== "SUCCESS") return [];
  return directVideoURL(taskBody(task.data)) ? [{ key: "video", type: "video", mimeType: "video/mp4" }] : [];
}

export function buildContentRequest(ctx) {
  if (ctx.artifactKey !== "video") throw new Error("未找到所请求的视频资源，请检查任务和资源类型。");
  const url = directVideoURL(taskBody(ctx.data));
  if (!url) throw new Error("视频结果暂不可用，请稍后查询任务；若任务已完成仍无法获取，请联系管理员。");
  return { url: url, method: ctx.clientRequest.method, credentialless: true };
}

function renderOpenAIVideo(task) {
  const statuses = { NOT_START: "queued", SUBMITTED: "queued", QUEUED: "queued", IN_PROGRESS: "in_progress", SUCCESS: "completed", FAILURE: "failed" };
  const output = {
    id: task.task_id,
    object: "video",
    model: (task.properties && task.properties.origin_model_name) || "",
    status: statuses[task.status] || "unknown",
    progress: Number(String(task.progress || "0").replace("%", "")),
    created_at: task.created_at,
  };
  if (task.status === "SUCCESS" || task.status === "FAILURE") output.completed_at = task.finish_time || task.updated_at;
  if (task.status === "FAILURE") output.error = { code: "video_task_failed", message: task.fail_reason || "视频生成失败，服务端未提供具体原因，请联系管理员。" };
  return output;
}

// Multipart file field -> [media kind, canonical request field].
const FILE_FIELDS = {
  first_frame: ["image", "first_frame_image"], first_frame_image: ["image", "first_frame_image"], start_frame: ["image", "first_frame_image"],
  last_frame: ["image", "last_frame_image"], last_frame_image: ["image", "last_frame_image"], end_frame: ["image", "last_frame_image"],
  input_reference: ["image", "images"], image: ["image", "images"], images: ["image", "images"], input_image: ["image", "images"],
  reference_image: ["image", "reference_images"], reference_images: ["image", "reference_images"],
  video: ["video", "reference_videos"], videos: ["video", "reference_videos"], reference_video: ["video", "reference_videos"], reference_videos: ["video", "reference_videos"],
  audio: ["audio", "reference_audios"], audios: ["audio", "reference_audios"], reference_audio: ["audio", "reference_audios"], reference_audios: ["audio", "reference_audios"],
};

function multipartRequest(body) {
  const request = {};
  const fields = body.fields || {};
  for (const name of Object.keys(fields)) {
    const values = fields[name] || [];
    if (values.length !== 1) throw new Error("参数重复提交：" + name);
    request[name] = values[0];
  }
  for (const name of ["metadata", "media", "content", "references", "output"]) {
    if (request[name] === undefined) continue;
    try {
      request[name] = JSON.parse(request[name]);
    } catch (_error) {
      throw new Error(name + " 必须为有效的 JSON。");
    }
  }
  const files = body.files || [];
  if (!files.length) return request;
  const metadata = Object.assign({}, object(request.metadata));
  const images = [];
  for (const file of files) {
    const target = FILE_FIELDS[trimmed(file.field).replace(/\[\]$/, "")];
    if (!target || !trimmed(file.ref) || !new RegExp("^" + target[0] + "/").test(file.mimeType || "")) {
      throw new Error("请上传有效的首尾帧、参考图片、参考视频或参考音频文件。");
    }
    const placeholder = { __fileRef: file.ref, encoding: "dataUrl" };
    if (target[1] === "images") images.push(placeholder);
    else metadata[target[1]] = asArray(metadata[target[1]]).concat([placeholder]);
  }
  if (images.length) request.images = asArray(request.images).concat(images);
  request.metadata = metadata;
  return request;
}

export const protocols = {
  openai_video: {
    decodeRequest: function (ctx) {
      if (!ctx.body || (ctx.body.kind !== "json" && ctx.body.kind !== "multipart")) throw new Error("请求格式不正确，请使用 JSON 或 multipart 提交。");
      let request;
      if (ctx.body.kind === "json") {
        if (!ctx.body.value || typeof ctx.body.value !== "object" || Array.isArray(ctx.body.value)) throw new Error("请求内容必须为 JSON 对象。");
        request = Object.assign({}, ctx.body.value);
      } else {
        request = multipartRequest(ctx.body);
      }
      // The canonical body is already upstream-shaped; driver hooks re-read it unchanged.
      const normalized = normalizedRequest(Object.assign({}, ctx, { requestBody: request }));
      const canonical = Object.assign({}, normalized.body, { model: ctx.model });
      if (Object.keys(normalized.extras).length) canonical.metadata = normalized.extras;
      return { kind: "submit", model: ctx.model, action: actionFor(canonical), requestBody: canonical };
    },
    render: function (_ctx, task) {
      return renderOpenAIVideo(task);
    },
  },
};
