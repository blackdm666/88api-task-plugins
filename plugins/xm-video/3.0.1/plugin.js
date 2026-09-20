const RATIOS = ["16:9", "9:16", "1:1", "4:3", "3:4"];
// Sales identity owns resolution; channel model_mapping owns the upstream ID.
// New models/capability changes belong here and can be uploaded without rebuilding
// the gateway. Do not derive a paid resolution from user-supplied metadata.
const MODEL_CONFIGS = {};
function addModel(name, upstream, resolution, overrides) {
  MODEL_CONFIGS[name] = Object.assign({ upstream: upstream, resolution: resolution,
    defaultDuration: 5, minDuration: 4, maxDuration: 15, defaultRatio: "16:9",
    ratios: RATIOS.concat(["21:9"]), maxPrompt: 5000, images: 9, videos: 3,
    audios: 3, framesExclusive: false, promptless: false, nativeMedia: false,
    generateAudio: false, visualWithAudio: false, totalMedia: 0 }, overrides);
}
for (const resolution of ["480p", "720p", "1080p"]) {
  const wan = "wan3.0-video-" + resolution;
  addModel(wan, wan, resolution, { maxDuration: 30, ratios: RATIOS, promptless: true,
    images: resolution === "480p" ? 30 : 10, videos: resolution === "480p" ? 10 : 5,
    audios: resolution === "480p" ? 10 : 5, framesExclusive: resolution !== "480p" });
  const dvc = "dvc-seedance-2.5" + (resolution === "720p" ? "" : "-" + resolution);
  addModel("SD2.5 " + resolution.toUpperCase(), dvc, resolution, {
    maxDuration: 30, defaultRatio: "auto", ratios: ["auto", "1:1", "21:9", "16:9", "9:16", "3:4", "4:3"],
    images: 30, videos: 10, audios: 10, framesExclusive: true,
    generateAudio: true });
  // The live cvd catalog has four qualities. A sales alias is mandatory so
  // the 480/720/1080 tiers cannot accidentally all generate the default 480p.
  addModel("SD2.0 " + resolution.toUpperCase(), "cvd-seedance-2.0", resolution, {
    defaultRatio: "1:1", framesExclusive: true, promptless: true,
    images: 9, videos: 3, audios: 3, totalMedia: 12 });
}
for (const resolution of ["480p", "720p"]) {
  const name = "seedance-2.0-mini-" + resolution;
  addModel(name, name, resolution, {});
}
for (const resolution of ["720p", "1080p", "2k", "4k"]) {
  addModel("kling-3.0-turbo-" + resolution, "kling-3.0-turbo", resolution, {
    ratios: ["16:9", "9:16", "1:1"], maxPrompt: 2000, images: 30, videos: 10,
    audios: 0, nativeMedia: true, generateAudio: true });
}
addModel("Seedance-2.5-720p官方版", "doubao-seedance-2-5-720p", "720p", {
  defaultDuration: 4, maxDuration: 30, images: 30, videos: 10, audios: 10, framesExclusive: true });
addModel("Seedance-2.0-720p官方版", "doubao-seedance-2-0-720p", "720p", { defaultDuration: 4, framesExclusive: true });
addModel("Seedance-2.0-fast-720p官方版", "doubao-seedance-2-0-fast-720p", "720p", { defaultDuration: 4, framesExclusive: true });
addModel("minimax-h3-768p", "minimax-h3-768p", "768p", { defaultDuration: 4,
  ratios: ["1:1", "16:9", "9:16"], maxPrompt: 2500, images: 10, videos: 5,
  audios: 5, visualWithAudio: true });
export const meta = {
  apiVersion: 1,
  key: "xm-video",
  name: "XM-Video",
  version: "3.0.1",
  author: { name: "88API" },
  description: { en: "88API channel integration plugin", zh: "88API渠道集成插件" },
  models: [],
  dynamicModels: true,
  fetchMode: "per_task",
  protocols: ["openai_video"],
  usageSchema: {
    seconds: { type: "number", unit: "second", description: { en: "Video generation unit price", zh: "视频生成单价" } },
  },
};

function object(value) { return value && typeof value === "object" && !Array.isArray(value) ? value : {}; }
function text(value) { return typeof value === "string" ? value.trim() : ""; }
function first() { for (const value of arguments) { if (text(value)) return text(value); } return ""; }
function firstArray() {
  for (const value of arguments) {
    if (Array.isArray(value) && value.length) return value.slice();
    if (text(value)) return [text(value)];
  }
  return [];
}
function secondsFor(req, cfg) {
  // The same validated value is sent upstream and supplied to both billing modes.
  // Match the legacy positive-duration precedence when both aliases are present.
  const duration = req.duration;
  const hasDuration = duration !== undefined && duration !== null && duration !== 0 && duration !== "0" && duration !== "";
  const hasSeconds = req.seconds !== undefined && req.seconds !== null && req.seconds !== "" && req.seconds !== 0 && req.seconds !== "0";
  const value = hasDuration ? duration : hasSeconds ? req.seconds : cfg.defaultDuration;
  if ((typeof value !== "number" && typeof value !== "string") || String(value).trim() === "") throw new Error("duration must be an integer");
  const seconds = Number(value);
  if (!Number.isInteger(seconds) || seconds < cfg.minDuration || seconds > cfg.maxDuration) throw new Error("duration must be an integer between " + cfg.minDuration + " and " + cfg.maxDuration);
  if (cfg.durations && !cfg.durations.includes(seconds)) throw new Error("unsupported duration");
  return seconds;
}
function modelConfig(model) {
  if (Object.prototype.hasOwnProperty.call(MODEL_CONFIGS, model)) return MODEL_CONFIGS[model];
  // Unknown models follow the standard contract without guessed capabilities.
  // Explicit duration keeps pre-consumption and the submitted quantity identical.
  return {
    upstream: model, resolution: "", minDuration: 1,
    maxDuration: Number.MAX_SAFE_INTEGER, defaultRatio: "", ratios: null,
    maxPrompt: Infinity, images: Infinity, videos: Infinity, audios: Infinity,
    promptless: true, generateAudio: true,
  };
}
function payloadFor(req, model, upstreamModel) {
  const cfg = modelConfig(Object.prototype.hasOwnProperty.call(MODEL_CONFIGS, model) ? model : upstreamModel || model);
  const metadata = object(typeof req.metadata === "string" ? JSON.parse(req.metadata) : req.metadata);
  const all = Object.assign({}, metadata, req);
  const sizeRatios = { "1280x720": "16:9", "1920x1080": "16:9", "2560x1440": "16:9", "720x1280": "9:16", "1080x1920": "9:16", "1440x2560": "9:16", "1024x1024": "1:1", "1440x1440": "1:1", "1920x1440": "4:3", "1440x1920": "3:4" };
  const body = {
    model: upstreamModel && upstreamModel !== model ? upstreamModel : cfg.upstream,
    ratio: first(all.ratio, all.aspect_ratio, (cfg.ratios || []).includes(req.size) ? req.size : req.size === "3360x1440" ? "21:9" : sizeRatios[req.size], cfg.defaultRatio),
    duration: secondsFor(req, cfg),
    resolution: cfg.resolution || first(all.resolution, all.quality, all.vquality),
  };
  if (!body.resolution) delete body.resolution;
  if (!body.ratio) delete body.ratio;
  // Existing SD2.5 clients send (or default to) "auto". VS2.5 does not
  // support it, so use its 16:9 default only when this mapped provider is
  // selected. Keep the sales resolution/duration and legacy DVC behavior.
  if (/^SD2\.5 (480P|720P|1080P)$/.test(model) &&
      body.model === "lltai-vs-2.5" && body.ratio === "auto") {
    body.ratio = "16:9";
  }
  const prompt = text(req.prompt);
  if (prompt) body.prompt = prompt;
  const negative = first(req.negative_prompt, metadata.negative_prompt);
  if (negative) body.negative_prompt = negative;
  const images = firstArray(req.images, req.image, req.input_reference, all.referenceImages, all.reference_images, all.image_urls, metadata.images, metadata.image, all.file_paths);
  const videos = firstArray(all.referenceVideos, all.reference_videos, all.video_urls, all.videos, all.video);
  const audios = firstArray(all.referenceAudios, all.reference_audios, all.audio_urls, all.audios, all.audio);
  for (const entry of [["referenceImages", images], ["referenceVideos", videos], ["referenceAudios", audios]]) {
    if (entry[1].length) {
      for (const value of entry[1]) {
        if (!text(value) && !(entry[0] === "referenceImages" && (object(value).__fileRef || cfg.nativeMedia && text(object(value).url)))) throw new Error(entry[0] + " must contain media references");
      }
      body[entry[0]] = entry[1];
    }
  }
  const firstFrame = first(all.firstFrame, all.first_frame, Array.isArray(all.first_image) ? all.first_image[0] : all.first_image);
  const lastFrame = first(all.lastFrame, all.last_frame, Array.isArray(all.last_image) ? all.last_image[0] : all.last_image);
  if (firstFrame) body.firstFrame = firstFrame;
  if (lastFrame) body.lastFrame = lastFrame;
  if (Array.isArray(all.media) && all.media.length) body.media = all.media.slice();
  if (all.seed !== undefined && all.seed !== null) {
    if (!Number.isSafeInteger(all.seed)) throw new Error("seed must be an integer");
    body.seed = all.seed;
  }
  if (Object.keys(object(all.camera_control)).length) body.camera_control = Object.assign({}, all.camera_control);
  const generateAudio = all.generateAudio !== undefined && all.generateAudio !== null ? all.generateAudio : all.generate_audio;
  if (generateAudio !== undefined && generateAudio !== null) {
    if (!cfg.generateAudio) throw new Error("generateAudio is not supported by model " + model);
    if (typeof generateAudio !== "boolean") throw new Error("generateAudio must be a boolean");
    body[cfg.nativeMedia ? "generate_audio" : "generateAudio"] = generateAudio;
  }
  if (!prompt && (!cfg.promptless || !images.length && !videos.length && !audios.length && !firstFrame && !lastFrame && !body.media)) throw new Error("prompt or supported reference media is required");
  if (Array.from(prompt).length > cfg.maxPrompt) throw new Error("prompt must contain at most " + cfg.maxPrompt + " characters");
  if (cfg.ratios && !cfg.ratios.includes(body.ratio)) throw new Error("unsupported aspect ratio");
  const imageCount = images.length + (cfg.nativeMedia ? Number(!!firstFrame) + Number(!!lastFrame) : 0);
  if (imageCount > cfg.images || videos.length > cfg.videos || audios.length > cfg.audios) throw new Error("too many media references");
  if (cfg.totalMedia && imageCount + videos.length + audios.length > cfg.totalMedia) throw new Error("too many media references in total");
  if (cfg.visualWithAudio && audios.length && !images.length && !videos.length && !firstFrame && !lastFrame) throw new Error("reference audios require an image or video");
  if (cfg.framesExclusive && (firstFrame || lastFrame) && (images.length || videos.length || audios.length)) throw new Error("first/last frame mode cannot be mixed with reference media");
  if (lastFrame && !firstFrame) throw new Error("lastFrame requires firstFrame");
  if (cfg.nativeMedia) {
    const nativeImages = images.slice();
    if (firstFrame) nativeImages.push({ url: firstFrame, role: "first_frame" });
    if (lastFrame) nativeImages.push({ url: lastFrame, role: "last_frame" });
    if (nativeImages.length) body.images = nativeImages;
    if (videos.length) body.videos = videos;
    delete body.referenceImages;
    delete body.referenceVideos;
    delete body.firstFrame;
    delete body.lastFrame;
  }
  return body;
}

export function decodeRequest(ctx) {
  if (!ctx.body || !["json", "multipart"].includes(ctx.body.kind)) throw new Error("JSON or multipart body required");
  let req;
  if (ctx.body.kind === "json") {
    if (!ctx.body.value || typeof ctx.body.value !== "object" || Array.isArray(ctx.body.value)) throw new Error("JSON object required");
    req = Object.assign({}, ctx.body.value);
  } else {
    req = {};
    for (const key of Object.keys(ctx.body.fields || {})) {
      const values = ctx.body.fields[key];
      if (values.length !== 1) throw new Error(key + " must be provided once");
      req[key] = values[0];
    }
    for (const key of ["metadata", "images", "videos", "audios", "image_urls", "video_urls", "audio_urls", "file_paths", "referenceImages", "reference_images", "referenceVideos", "reference_videos", "referenceAudios", "reference_audios", "media", "camera_control", "seed", "generateAudio", "generate_audio"]) {
      if (req[key] !== undefined) {
        try { req[key] = JSON.parse(req[key]); } catch (_error) { throw new Error(key + " must be valid JSON"); }
      }
    }
    const files = ctx.body.files || [];
    if (files.length > 1 || files.some(function (file) { return file.field !== "input_reference"; })) throw new Error("only one input_reference file is supported");
    if (files.length) {
      if (req.images || req.image || req.input_reference) throw new Error("input_reference file cannot be combined with image fields");
      req.images = [{ __fileRef: files[0].ref, encoding: "dataUrl" }];
    }
  }
  if (typeof req.metadata === "string") {
    try { req.metadata = JSON.parse(req.metadata); } catch (_error) { throw new Error("metadata must be a JSON object or an encoded JSON object"); }
  }
  if (req.metadata !== undefined && req.metadata !== null && (typeof req.metadata !== "object" || Array.isArray(req.metadata))) throw new Error("metadata must be an object");
  if (req.callback_url !== undefined && req.callback_url !== null && req.callback_url !== "") throw new Error("callback_url is not supported for this model; poll GET /v1/videos/{id} for the result");
  delete req.callback_url;
  req.model = ctx.model;
  const payload = payloadFor(req, ctx.model);
  req.duration = payload.duration;
  delete req.seconds;
  return { kind: "submit", model: ctx.model, action: payload.referenceImages || payload.referenceVideos || payload.referenceAudios || payload.firstFrame || payload.media || payload.images || payload.videos ? "image_to_video" : "text_to_video", requestBody: req };
}

function base(ctx) { return String(ctx.baseUrl).replace(/\/+$/, "").replace(/\/v1$/, ""); }
export function buildSubmitRequest(ctx) {
  return { url: base(ctx) + "/v1/videos/generations", method: "POST", headers: { Authorization: "Bearer " + ctx.apiKey, "Content-Type": "application/json" }, body: payloadFor(object(ctx.requestBody), ctx.model, ctx.upstreamModel) };
}
export function extractUsage(ctx) { return { seconds: secondsFor(object(ctx.requestBody), modelConfig(ctx.model)) }; }

function taskBody(value) {
  const body = object(value);
  return body.status !== undefined || body.id || body.task_id ? body : object(body.data);
}
function errorMessage(body) { return first(object(body.error).message, body.error, body.message, "video generation failed"); }
function resultURL(value, depth) {
  if ((depth || 0) > 4) return "";
  if (text(value)) return /^https?:\/\//i.test(text(value)) ? text(value) : "";
  if (Array.isArray(value)) { for (const item of value) { const url = resultURL(item, (depth || 0) + 1); if (url) return url; } return ""; }
  const body = object(value);
  for (const key of ["result", "video_url", "result_url", "url", "data"]) { const url = resultURL(body[key], (depth || 0) + 1); if (url) return url; }
  return "";
}
export function parseSubmitResponse(_ctx, response) {
  const body = taskBody(response.body);
  if (["failed", "cancelled", "expired"].includes(String(body.status).toLowerCase())) throw new Error(errorMessage(body));
  const id = first(body.id, body.task_id);
  if (!id) throw new Error("upstream task id is empty");
  return { taskId: id, taskData: response.body };
}
export function buildQueryRequest(ctx) {
  return { url: base(ctx) + "/v1/tasks/" + encodeURIComponent(ctx.taskId), method: "GET", headers: { Authorization: "Bearer " + ctx.apiKey, Accept: "application/json" } };
}
export function parseTaskResult(_ctx, value) {
  const body = taskBody(value);
  const statuses = { pending: "QUEUED", queued: "QUEUED", submitted: "QUEUED", processing: "IN_PROGRESS", in_progress: "IN_PROGRESS", running: "IN_PROGRESS", completed: "SUCCESS", success: "SUCCESS", succeeded: "SUCCESS", done: "SUCCESS", failed: "FAILURE", cancelled: "FAILURE", expired: "FAILURE" };
  const status = statuses[String(body.status || "").trim().toLowerCase()];
  if (!status) return { status: "UNKNOWN", reason: "unrecognized XinMeng task status" };
  const terminal = status === "SUCCESS" || status === "FAILURE";
  const progress = Number(String(body.progress || "0").replace(/%$/, ""));
  const result = { status: status, progress: terminal ? "100%" : (Number.isFinite(progress) ? Math.max(0, Math.min(99, Math.floor(progress))) : 0) + "%" };
  if (status === "SUCCESS") {
    const url = resultURL(body);
    if (!url) return { status: "FAILURE", progress: "100%", reason: "XinMeng completed the task without a video URL" };
    result.url = url;
  }
  if (status === "FAILURE") result.reason = errorMessage(body);
  return result;
}
// XinMeng's existing Wan3 contract bills the requested duration. Completion
// keeps the host's frozen seconds fact; pointsCost/actualDuration are not prices.
export function listArtifacts(task) { return task.status === "SUCCESS" && resultURL(task.data) ? [{ key: "video", type: "video", mimeType: "video/mp4" }] : []; }
export function buildContentRequest(ctx) {
  const url = resultURL(ctx.data);
  if (ctx.artifactKey !== "video" || !url) throw new Error("artifact_not_found");
  return { url: url, method: ctx.clientRequest.method, credentialless: true };
}
export const protocols = {
  openai_video: {
    decodeRequest: decodeRequest,
    render: function (_ctx, task) {
      const statuses = { NOT_START: "queued", SUBMITTED: "queued", QUEUED: "queued", IN_PROGRESS: "in_progress", SUCCESS: "completed", FAILURE: "failed" };
      const result = { id: task.task_id, object: "video", model: object(task.properties).origin_model_name || "", status: statuses[task.status] || "unknown", progress: Number(String(task.progress || "0").replace("%", "")), created_at: task.created_at };
      if (task.status === "SUCCESS" || task.status === "FAILURE") result.completed_at = task.updated_at;
      if (task.status === "FAILURE") result.error = { code: "video_generation_failed", message: task.fail_reason || "video generation failed" };
      return result;
    },
  },
};
