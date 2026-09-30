const RATIOS = ["16:9", "4:3", "1:1", "3:4", "9:16", "21:9", "adaptive"];
const RESOLUTIONS = ["480p", "720p", "1080p", "4k"];
const TASK_TYPES = ["auto", "reference", "edit", "extend"];
const DEFAULT_MAX_DURATION = 30;

const MODEL_CONFIGS = {
  "doubao-seedance-2-0-mini-260615": {
    family: "2.0-mini", defaultDuration: 5, maxDuration: 15, defaultResolution: "720p",
    resolutions: ["480p", "720p"], images: 9, videos: 3, audios: 3,
    generateAudio: true,
  },
  "doubao-seedance-2-0-260128": {
    family: "2.0", defaultDuration: 5, maxDuration: 15, defaultResolution: "720p",
    resolutions: ["480p", "720p", "1080p", "4k"], images: 9, videos: 3, audios: 3,
    generateAudio: true,
  },
  "doubao-seedance-2-0-fast-260128": {
    family: "2.0-fast", defaultDuration: 5, maxDuration: 15, defaultResolution: "720p",
    resolutions: ["480p", "720p"], images: 9, videos: 3, audios: 3,
    generateAudio: true,
  },
  "doubao-seedance-2-5-260628": {
    family: "2.5", defaultDuration: -1, maxDuration: 30, defaultResolution: "720p",
    resolutions: ["480p", "720p", "1080p"], images: 30, videos: 10, audios: 10,
    generateAudio: true, omni: true, outputFormat: true,
  },
  "doubao-seedance-1-5-pro-251215": {
    family: "1.5", defaultDuration: -1, maxDuration: 12, defaultResolution: "720p",
    resolutions: ["480p", "720p", "1080p"], images: 1, videos: 0, audios: 0,
    generateAudio: true, seed: true, camera: true, serviceTier: true, draft: true,
  },
  "doubao-seedance-1-0-pro-250528": {
    family: "1.0", defaultDuration: 2, minDuration: 2, maxDuration: 12,
    defaultResolution: "1080p", resolutions: ["480p", "720p", "1080p"],
    images: 1, videos: 0, audios: 0, seed: true, camera: true, serviceTier: true,
    frames: true,
  },
  "doubao-seedance-1-0-pro-fast-251015": {
    family: "1.0-fast", defaultDuration: 2, minDuration: 2, maxDuration: 12,
    defaultResolution: "1080p", resolutions: ["480p", "720p", "1080p"],
    images: 1, videos: 0, audios: 0, seed: true, camera: true, serviceTier: true,
    frames: true,
  },
};

export const meta = {
  apiVersion: 1,
  key: "sdgo-video",
  name: "SD-Video",
  version: "1.0.1",
  author: { name: "88API" },
  description: {
    en: "Seedance video generation through the SDGO OpenAI-compatible task API",
    zh: "通过 SDGO OpenAI 兼容任务接口接入 Seedance 视频生成",
  },
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
    resolution: {
      enum: RESOLUTIONS,
      enumLabels: Object.fromEntries(RESOLUTIONS.map((value) => [value, { en: value, zh: value }])),
      description: { en: "Output video resolution", zh: "输出视频分辨率" },
    },
    upstreamUnits: {
      type: "number",
      unit: "token",
      description: { en: "Completed Ark output token unit price", zh: "Ark 完成任务输出 Token 单价" },
    },
  },
  usageExamples: [
    { label: "5s · 720p", facts: { seconds: 5, resolution: "720p", upstreamUnits: 216900 } },
    { label: "10s · 1080p", facts: { seconds: 10, resolution: "1080p", upstreamUnits: 216900 } },
  ],
};

function object(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

function asArray(value) {
  if (value === undefined || value === null || value === "") return [];
  return Array.isArray(value) ? value.slice() : [value];
}

function first() {
  for (const value of arguments) {
    const result = text(value);
    if (result) return result;
  }
  return "";
}

function parseMetadata(value) {
  if (value === undefined || value === null || value === "") return {};
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch (_error) {
      throw new Error("metadata 参数格式不正确，请提供有效的 JSON 对象。");
    }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("metadata 参数格式不正确，请提供 JSON 对象。");
  }
  return value;
}

function modelConfig(model) {
  return MODEL_CONFIGS[model] || {
    family: "unknown",
    defaultDuration: 5,
    minDuration: 1,
    maxDuration: Number.MAX_SAFE_INTEGER,
    defaultResolution: "720p",
    resolutions: RESOLUTIONS,
    images: Infinity,
    videos: Infinity,
    audios: Infinity,
    generateAudio: true,
    omni: true,
    outputFormat: true,
    seed: true,
    camera: true,
    serviceTier: true,
    frames: true,
    draft: true,
  };
}

function urlFor(value, field, kind) {
  let url = "";
  let role = "";
  if (typeof value === "string") {
    url = value.trim();
  } else if (value && typeof value === "object" && !Array.isArray(value)) {
    url = text(value.url);
    role = text(value.role);
  }
  const allowed = kind === "video"
    ? /^https:\/\//i.test(url) || /^asset:\/\//i.test(url)
    : /^https:\/\//i.test(url) || /^asset:\/\//i.test(url) || /^data:/i.test(url);
  if (!url || !allowed) {
    throw new Error(field + "必须是可被网关和上游访问的 HTTPS、asset:// 或受支持的内联数据地址。");
  }
  return { url, role };
}

function contentItem(type, media, defaultRole) {
  const contentType = type.endsWith("_url") ? type : type + "_url";
  const key = contentType;
  const item = { type: contentType };
  if (media.role || defaultRole) item.role = media.role || defaultRole;
  item[key] = { url: media.url };
  return item;
}

function mediaItems(values, field, kind, role) {
  return asArray(values).map((value) => contentItem(kind, urlFor(value, field, kind), role));
}

function contentText(content) {
  return content
    .filter((item) => item.type === "text")
    .map((item) => text(item.text))
    .filter(Boolean)
    .join("\n");
}

function normalizeContent(value, prompt) {
  if (value !== undefined && !Array.isArray(value)) throw new Error("content 必须是数组。");
  const content = Array.isArray(value) ? value.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item) || !text(item.type)) {
      throw new Error("content 中的项目格式无效。");
    }
    return JSON.parse(JSON.stringify(item));
  }) : [];
  if (prompt && !contentText(content)) content.unshift({ type: "text", text: prompt });
  return content;
}

function mediaKey(item) {
  const type = text(item.type);
  const role = text(item.role);
  const nested = object(item[type]);
  return type + "\u0000" + role + "\u0000" + text(nested.url);
}

function appendUnique(content, items) {
  const seen = new Set(content.map(mediaKey));
  for (const item of items) {
    const key = mediaKey(item);
    if (!seen.has(key)) {
      seen.add(key);
      content.push(item);
    }
  }
  return content;
}

function mediaSummary(content) {
  return {
    text: content.filter((item) => item.type === "text"),
    images: content.filter((item) => item.type === "image_url"),
    videos: content.filter((item) => item.type === "video_url"),
    audios: content.filter((item) => item.type === "audio_url"),
  };
}

function integer(value, field) {
  if (typeof value === "boolean" || value === null || value === "") throw new Error(field + "必须是整数。");
  const number = Number(value);
  if (!Number.isSafeInteger(number)) throw new Error(field + "必须是整数。");
  return number;
}

function durationFor(value, cfg) {
  if (value === undefined || value === null || value === "") return cfg.defaultDuration;
  const duration = integer(value, "视频时长");
  if (duration === -1) return duration;
  const min = cfg.minDuration || 4;
  if (duration < min || duration > cfg.maxDuration) {
    throw new Error("视频时长需为 -1 或 " + min + " 到 " + cfg.maxDuration + " 秒之间的整数。");
  }
  return duration;
}

function resolutionFor(value, cfg) {
  const resolution = first(value, cfg.defaultResolution).toLowerCase();
  if (!cfg.resolutions.includes(resolution)) {
    throw new Error("当前模型不支持该分辨率，请选择：" + cfg.resolutions.join("、") + "。");
  }
  return resolution;
}

function ratioFor(value, cfg, hasFrame) {
  const ratio = first(value, cfg.family === "1.0" || cfg.family === "1.0-fast" ? "16:9" : "adaptive");
  if (!RATIOS.includes(ratio)) {
    throw new Error("当前模型不支持该画幅比例，请选择：" + RATIOS.join("、") + "。");
  }
  if (hasFrame && cfg.family === "2.5" && ratio !== "adaptive") {
    throw new Error("Seedance 2.5 的首帧和首尾帧任务必须使用 adaptive 比例。");
  }
  return ratio;
}

function booleanFor(value, field) {
  if (typeof value !== "boolean") throw new Error(field + "参数无效，请使用 true 或 false。");
  return value;
}

function parseMediaFromContent(content) {
  for (const item of content) {
    if (!["text", "image_url", "video_url", "audio_url", "draft_task"].includes(item.type)) {
      throw new Error("content 中包含不支持的内容类型：" + item.type + "。");
    }
    if (item.type === "text" && !text(item.text)) throw new Error("content 的 text 项不能为空。");
    if (item.type === "draft_task" && !text(object(item.draft_task).id)) {
      throw new Error("content 的 draft_task 必须包含 id。");
    }
    if (item.type === "image_url") {
      const media = urlFor(object(item.image_url), "参考图片", "image");
      if (item.role && !["first_frame", "last_frame", "reference_image"].includes(item.role)) {
        throw new Error("image_url 的 role 只支持 first_frame、last_frame 或 reference_image。");
      }
      item.image_url = { url: media.url };
    }
    if (item.type === "video_url") {
      const media = urlFor(object(item.video_url), "参考视频", "video");
      if (item.role !== "reference_video") throw new Error("video_url 的 role 必须为 reference_video。");
      item.video_url = { url: media.url };
    }
    if (item.type === "audio_url") {
      const media = urlFor(object(item.audio_url), "参考音频", "audio");
      if (item.role !== "reference_audio") throw new Error("audio_url 的 role 必须为 reference_audio。");
      item.audio_url = { url: media.url };
    }
  }
  return mediaSummary(content);
}

const COMPATIBILITY_KEYS = new Set([
  "metadata", "prompt", "content", "images", "image", "image_urls", "input_reference",
  "videos", "video", "video_urls", "audios", "audio", "audio_urls",
  "referenceImages", "reference_images", "referenceVideos", "reference_videos",
  "referenceAudios", "reference_audios", "firstFrame", "first_frame", "lastFrame",
  "last_frame", "seconds", "duration", "quality", "vquality", "aspect_ratio",
  "outputFormat", "generateAudio", "omniReferenceTaskType",
]);

function copyForwardFields(body, all) {
  for (const [key, value] of Object.entries(all)) {
    if (!COMPATIBILITY_KEYS.has(key) && key !== "model" && body[key] === undefined) body[key] = value;
  }
  return body;
}

function payloadFor(request, model, upstreamModel) {
  const req = object(request);
  const metadata = parseMetadata(req.metadata);
  // SDGO accepts legacy metadata, but documents metadata as taking precedence.
  const all = Object.assign({}, req, metadata);
  const upstream = first(upstreamModel, model);
  if (!upstream) throw new Error("model 是必填参数。");
  const cfg = modelConfig(upstream);
  const prompt = first(all.prompt);
  const content = normalizeContent(all.content, prompt);
  const summary = parseMediaFromContent(content);
  const firstFrame = first(all.firstFrame, all.first_frame);
  const lastFrame = first(all.lastFrame, all.last_frame);
  if (lastFrame && !firstFrame) throw new Error("请先提供首帧，再提供尾帧。");
  const frameItems = [];
  if (firstFrame) frameItems.push(contentItem("image", urlFor(firstFrame, "首帧", "image"), "first_frame"));
  if (lastFrame) frameItems.push(contentItem("image", urlFor(lastFrame, "尾帧", "image"), "last_frame"));
  appendUnique(content, frameItems);
  appendUnique(content, mediaItems(
    [...asArray(all.images), ...asArray(all.image_urls), ...asArray(all.referenceImages), ...asArray(all.reference_images)],
    "参考图片", "image", "reference_image",
  ));
  appendUnique(content, mediaItems(
    [...asArray(all.videos), ...asArray(all.video_urls), ...asArray(all.referenceVideos), ...asArray(all.reference_videos)],
    "参考视频", "video", "reference_video",
  ));
  appendUnique(content, mediaItems(
    [...asArray(all.audios), ...asArray(all.audio_urls), ...asArray(all.referenceAudios), ...asArray(all.reference_audios)],
    "参考音频", "audio", "reference_audio",
  ));
  const media = parseMediaFromContent(content);
  const hasFrame = media.images.some((item) => ["first_frame", "last_frame"].includes(item.role));
  if (!content.length) throw new Error("请输入提示词，或添加参考图片、视频、音频。");
  if (media.images.length > cfg.images) throw new Error("参考图片过多，当前模型最多支持 " + cfg.images + " 张。");
  if (media.videos.length > cfg.videos) throw new Error(cfg.videos === 0 ? "当前模型不支持参考视频。" : "参考视频过多，当前模型最多支持 " + cfg.videos + " 个。");
  if (media.audios.length > cfg.audios) throw new Error(cfg.audios === 0 ? "当前模型不支持参考音频。" : "参考音频过多，当前模型最多支持 " + cfg.audios + " 段。");
  if (hasFrame && (media.images.some((item) => item.role === "reference_image") || media.videos.length || media.audios.length)) {
    throw new Error("首帧或首尾帧输入不能与参考图片、视频或音频混用。");
  }
  if (cfg.family === "2.0" || cfg.family === "2.0-mini" || cfg.family === "2.0-fast") {
    if (media.audios.length && !media.images.length && !media.videos.length) {
      throw new Error("Seedance 2.0 使用参考音频时，必须同时提供参考图片或参考视频。");
    }
  }
  const duration = durationFor(all.duration !== undefined ? all.duration : all.seconds, cfg);
  if (duration === -1 && (cfg.family === "1.0" || cfg.family === "1.0-fast")) {
    throw new Error("Seedance 1.0 不支持 -1 时长。");
  }
  const resolution = resolutionFor(first(all.resolution, all.quality, all.vquality), cfg);
  const ratio = ratioFor(first(all.ratio, all.aspect_ratio), cfg, hasFrame);
  const body = { model: upstream, content, duration, resolution, ratio };
  const taskType = first(all.omni_reference_task_type, all.omniReferenceTaskType);
  if (taskType) {
    if (!cfg.omni) throw new Error("omni_reference_task_type 仅 Seedance 2.5 支持。");
    if (!TASK_TYPES.includes(taskType)) throw new Error("omni_reference_task_type 只支持 auto、reference、edit 或 extend。");
    if (taskType === "edit" && (!media.videos.length || ratio !== "adaptive" || duration !== -1)) {
      throw new Error("Seedance 2.5 的 edit 任务要求 reference_video、adaptive 比例和 -1 时长。");
    }
    if (taskType === "extend" && (!media.videos.length || ratio !== "adaptive")) {
      throw new Error("Seedance 2.5 的 extend 任务要求 reference_video 和 adaptive 比例。");
    }
    body.omni_reference_task_type = taskType;
  }
  const generateAudio = all.generateAudio !== undefined ? all.generateAudio : all.generate_audio;
  if (generateAudio !== undefined && generateAudio !== null && generateAudio !== "") {
    if (!cfg.generateAudio) throw new Error("当前模型不支持 generate_audio。");
    body.generate_audio = booleanFor(generateAudio, "音频开关");
  }
  const outputFormat = first(all.output_format, all.outputFormat);
  if (outputFormat) {
    if (!cfg.outputFormat) throw new Error("当前模型不支持 output_format。");
    if (!["mp4", "mov"].includes(outputFormat.toLowerCase())) throw new Error("输出格式只支持 mp4 或 mov。");
    body.output_format = outputFormat.toLowerCase();
  }
  if (all.frames !== undefined && all.frames !== null && all.frames !== "") {
    if (!cfg.frames) throw new Error("当前模型不支持 frames。");
    const frames = integer(all.frames, "frames");
    if (frames < 29 || frames > 289 || (frames - 25) % 4 !== 0) throw new Error("frames 必须为 29 到 289 之间且符合 25+4n。");
    body.frames = frames;
  }
  if (all.seed !== undefined && all.seed !== null && all.seed !== "") {
    if (!cfg.seed) throw new Error("当前模型不支持 seed。");
    const seed = integer(all.seed, "随机种子");
    if (seed < -1 || seed > 2147483647) throw new Error("随机种子必须在 -1 到 2147483647 之间。");
    body.seed = seed;
  }
  if (all.camera_fixed !== undefined && all.camera_fixed !== null && all.camera_fixed !== "") {
    if (!cfg.camera) throw new Error("当前模型不支持 camera_fixed。");
    if (hasFrame) throw new Error("参考图任务不支持 camera_fixed。");
    body.camera_fixed = booleanFor(all.camera_fixed, "固定镜头");
  }
  const serviceTier = first(all.service_tier);
  if (serviceTier) {
    if (!cfg.serviceTier || !["default", "flex"].includes(serviceTier)) throw new Error("service_tier 只支持 default 或 flex，且当前模型不支持该字段。");
    body.service_tier = serviceTier;
  }
  if (all.draft !== undefined && all.draft !== null && all.draft !== "") {
    if (!cfg.draft) throw new Error("当前模型不支持 draft。");
    body.draft = booleanFor(all.draft, "draft");
    if (body.draft) {
      if (hasFrame || all.return_last_frame === true || body.service_tier === "flex") throw new Error("draft=true 不能与首尾帧、return_last_frame 或 flex 同时使用。");
      body.resolution = "480p";
    }
  }
  if (all.priority !== undefined && all.priority !== null && all.priority !== "") {
    if (!["2.0", "2.0-mini", "2.0-fast", "2.5"].includes(cfg.family)) throw new Error("当前模型不支持 priority。");
    const priority = integer(all.priority, "priority");
    if (priority < 0 || priority > 9) throw new Error("priority 必须为 0 到 9 之间的整数。");
    if (body.service_tier === "flex") throw new Error("priority 不能与 service_tier=flex 同时使用。");
    body.priority = priority;
  }
  return copyForwardFields(body, all);
}

function parseMultipart(ctx) {
  const req = {};
  const fields = ctx.body.fields || {};
  for (const key of Object.keys(fields)) {
    if (!Array.isArray(fields[key]) || fields[key].length !== 1) throw new Error("参数重复提交，请检查“" + key + "”。");
    req[key] = fields[key][0];
  }
  for (const key of [
    "metadata", "content", "images", "image_urls", "videos", "video_urls", "audios", "audio_urls",
    "referenceImages", "reference_images", "referenceVideos", "reference_videos", "referenceAudios",
    "reference_audios", "seed", "generateAudio", "generate_audio", "omni_reference_task_type",
    "frames", "camera_fixed", "return_last_frame", "draft", "priority", "tools",
  ]) {
    if (req[key] === undefined) continue;
    try {
      req[key] = JSON.parse(req[key]);
    } catch (_error) {
      throw new Error("参数“" + key + "”格式不正确，请提供有效的 JSON。");
    }
  }
  if ((ctx.body.files || []).length) throw new Error("SDGO 官方 /api/v3 接口要求使用 URL 或 asset:// 素材，不支持直接上传文件。");
  return req;
}

export function decodeRequest(ctx) {
  if (!ctx.body || !["json", "multipart"].includes(ctx.body.kind)) throw new Error("请求格式不正确，请使用 JSON 或 multipart/form-data 提交。");
  let req;
  if (ctx.body.kind === "json") {
    if (!ctx.body.value || typeof ctx.body.value !== "object" || Array.isArray(ctx.body.value)) {
      throw new Error("请求内容格式不正确，请提交一个 JSON 对象。");
    }
    req = Object.assign({}, ctx.body.value);
  } else {
    req = parseMultipart(ctx);
  }
  const body = payloadFor(req, ctx.model, ctx.upstreamModel);
  return {
    kind: "submit",
    model: ctx.model,
    action: body.content.some((item) => item.type !== "text") ? "image_to_video" : "text_to_video",
    requestBody: body,
  };
}

function base(ctx) {
  return text(ctx.baseUrl).replace(/\/+$/, "").replace(/\/api\/v3$/i, "").replace(/\/v1$/i, "");
}

export function buildSubmitRequest(ctx) {
  return {
    url: base(ctx) + "/api/v3/contents/generations/tasks",
    method: "POST",
    headers: {
      Authorization: "Bearer " + ctx.apiKey,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: payloadFor(ctx.requestBody, ctx.model, ctx.upstreamModel),
  };
}

function taskBody(value) {
  const body = object(value);
  return body.status !== undefined || body.id || body.task_id ? body : object(body.data);
}

function errorMessage(body) {
  const error = object(body.error);
  return first(error.message, typeof body.error === "string" ? body.error : "", body.message, "视频生成失败，请稍后重试。");
}

function resultURL(body) {
  return text(object(body.content).video_url);
}

export function parseSubmitResponse(_ctx, response) {
  const body = taskBody(response.body);
  if (["failed", "cancelled", "expired"].includes(text(body.status).toLowerCase())) throw new Error(errorMessage(body));
  const id = first(body.id, body.task_id);
  if (!id) throw new Error("暂未获取到任务编号，无法确认提交结果，请联系管理员核查，勿重复提交。");
  return { taskId: id, taskData: response.body };
}

export function buildQueryRequest(ctx) {
  return {
    url: base(ctx) + "/api/v3/contents/generations/tasks/" + encodeURIComponent(ctx.taskId),
    method: "GET",
    headers: { Authorization: "Bearer " + ctx.apiKey, Accept: "application/json" },
  };
}

function progressFor(body, terminal) {
  if (terminal) return "100%";
  const progress = Number(String(body.progress === undefined ? 0 : body.progress).replace(/%$/, ""));
  return Number.isFinite(progress) ? Math.max(0, Math.min(99, Math.floor(progress))) + "%" : "0%";
}

export function parseTaskResult(_ctx, value) {
  const body = taskBody(value);
  const status = text(body.status).toLowerCase();
  if (["queued", "pending", "submitted"].includes(status)) return { status: "QUEUED", progress: progressFor(body, false) };
  if (["running", "processing", "in_progress"].includes(status)) return { status: "IN_PROGRESS", progress: progressFor(body, false) };
  if (["succeeded", "completed", "success", "done"].includes(status)) {
    const url = resultURL(body);
    if (!url) return { status: "FAILURE", progress: "100%", reason: "视频服务报告任务已完成，但未返回视频地址，请联系管理员核查。" };
    const result = { status: "SUCCESS", progress: "100%", url };
    const usage = object(body.usage);
    const completionTokens = Number(usage.completion_tokens || 0);
    const totalTokens = Number(usage.total_tokens || 0);
    if (Number.isFinite(completionTokens) && completionTokens > 0) result.completionTokens = completionTokens;
    if (Number.isFinite(totalTokens) && totalTokens > 0) result.totalTokens = totalTokens;
    return result;
  }
  if (["failed", "cancelled", "expired"].includes(status)) return { status: "FAILURE", progress: "100%", reason: errorMessage(body) };
  return { status: "UNKNOWN", reason: "暂时无法识别视频任务状态，请稍后查询，无需重新提交。" };
}

function secondsFor(request) {
  const cfg = modelConfig(first(object(request).model));
  const seconds = Number(object(request).duration);
  if (seconds === -1) return cfg.maxDuration === Number.MAX_SAFE_INTEGER ? DEFAULT_MAX_DURATION : cfg.maxDuration;
  return Number.isInteger(seconds) && seconds >= (cfg.minDuration || 4) ? Math.min(seconds, cfg.maxDuration) : cfg.defaultDuration;
}

function resolutionFrom(value) {
  const resolution = text(object(value).resolution) || text(object(value).content && object(value).content.resolution);
  return RESOLUTIONS.includes(resolution.toLowerCase()) ? resolution.toLowerCase() : "";
}

export function extractUsage(ctx) {
  const request = object(ctx.requestBody);
  const model = first(ctx.upstreamModel, ctx.model, request.model);
  const cfg = modelConfig(model);
  const resolution = resolutionFrom(request) || cfg.defaultResolution;
  return { seconds: secondsFor(Object.assign({ model }, request)), resolution };
}

export function extractUsageOnComplete(_task, _taskResult, body) {
  const value = taskBody(body);
  if (text(value.status).toLowerCase() !== "succeeded") return {};
  const facts = {};
  const duration = Number(value.duration);
  if (Number.isInteger(duration) && duration > 0) facts.seconds = duration;
  const resolution = resolutionFrom(value);
  if (resolution) facts.resolution = resolution;
  const usage = object(value.usage);
  const completionTokens = Number(usage.completion_tokens || 0);
  if (Number.isFinite(completionTokens) && completionTokens > 0) facts.upstreamUnits = completionTokens;
  return facts;
}

export function listArtifacts(task) {
  if (task.status !== "SUCCESS" || !resultURL(task.data)) return [];
  const format = text(object(task.data).output_format || "mp4").toLowerCase();
  return [{ key: "video", type: "video", mimeType: format === "mov" ? "video/quicktime" : "video/mp4" }];
}

export function buildContentRequest(ctx) {
  const url = resultURL(ctx.data);
  if (ctx.artifactKey !== "video" || !url) throw new Error("视频结果暂不可用，请稍后重试。");
  return { url, method: ctx.clientRequest.method, credentialless: true };
}

export const protocols = {
  openai_video: {
    decodeRequest,
    render: function (_ctx, task) {
      const statuses = {
        NOT_START: "queued", SUBMITTED: "queued", QUEUED: "queued",
        IN_PROGRESS: "in_progress", SUCCESS: "completed", FAILURE: "failed",
      };
      const result = {
        id: task.task_id,
        object: "video",
        model: object(task.properties).origin_model_name || "",
        status: statuses[task.status] || "unknown",
        progress: Number(String(task.progress || "0").replace("%", "")),
        created_at: task.created_at,
      };
      if (task.status === "SUCCESS" || task.status === "FAILURE") result.completed_at = task.updated_at;
      if (task.status === "FAILURE") {
        result.error = { code: "video_generation_failed", message: task.fail_reason || "视频生成失败，请稍后重试。" };
      }
      return result;
    },
  },
};
