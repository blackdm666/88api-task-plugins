const RATIOS = ["21:9", "16:9", "4:3", "1:1", "3:4", "9:16", "adaptive"];
const RESOLUTIONS = ["480p", "720p", "1080p", "4k"];
const VIDEO_INPUTS = ["none", "present"];
const TASK_TYPES = ["auto", "edit", "extend"];
const MAX_IMAGES = 30;
const MAX_VIDEOS = 10;
const MAX_AUDIOS = 10;
const DEFAULT_DURATION = 5;
const MAX_DURATION = 30;

export const meta = {
  apiVersion: 1,
  key: "gx-video",
  name: "GX-Video",
  version: "1.0.1",
  author: { name: "88API" },
  description: {
    en: "Seedance native video generation through the GX task API",
    zh: "通过 GX 任务接口接入 Seedance 原生视频生成",
  },
  // The channel exposes the provider's current sales names. Keeping the
  // plugin dynamic lets an administrator add a newly published model without
  // changing the plugin identity or rebuilding the gateway.
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
      enumLabels: {
        "480p": { en: "480p", zh: "480p" },
        "720p": { en: "720p", zh: "720p" },
        "1080p": { en: "1080p", zh: "1080p" },
        "4k": { en: "4K", zh: "4K" },
      },
      description: { en: "Output video resolution", zh: "输出视频分辨率" },
    },
    video_input: {
      enum: VIDEO_INPUTS,
      enumLabels: {
        none: { en: "No reference video", zh: "无参考视频" },
        present: { en: "With reference video", zh: "有参考视频" },
      },
      description: { en: "Reference video pricing variant", zh: "参考视频计费档位" },
    },
    upstreamUnits: {
      type: "number",
      unit: "token",
      description: { en: "Completed GX output tokens", zh: "GX 完成任务返回的输出 Token" },
    },
  },
  usageExamples: [
    { label: "5s · 720p · 无参考视频", facts: { seconds: 5, resolution: "720p", video_input: "none", upstreamUnits: 500000 } },
    { label: "10s · 1080p · 有参考视频", facts: { seconds: 10, resolution: "1080p", video_input: "present", upstreamUnits: 500000 } },
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

function httpsURL(value, field, role) {
  let url = "";
  let itemRole = role || "";
  if (typeof value === "string") {
    url = value.trim();
  } else if (value && typeof value === "object" && !Array.isArray(value)) {
    url = text(value.url);
    itemRole = text(value.role) || itemRole;
  }
  if (!url || !/^https:\/\//i.test(url)) {
    throw new Error(field + "必须是无需登录即可访问的 HTTPS URL。");
  }
  const result = { url: url };
  if (itemRole) result.role = itemRole;
  return result;
}

function mediaItems(values, field, role) {
  return asArray(values).map((value) => httpsURL(value, field, role));
}

function dedupeMedia(items) {
  const seen = new Set();
  return items.filter((item) => {
    const key = item.url + "\u0000" + (item.role || "");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function integer(value, field) {
  if (typeof value === "boolean" || value === null || value === "") throw new Error(field + "必须是整数。");
  const number = Number(value);
  if (!Number.isSafeInteger(number)) throw new Error(field + "必须是整数。");
  return number;
}

function durationFor(value) {
  if (value === undefined || value === null || value === "") return DEFAULT_DURATION;
  const duration = integer(value, "视频时长");
  if (duration === -1) return duration;
  if (duration < 4 || duration > MAX_DURATION) {
    throw new Error("视频时长需为 -1 或 4 到 30 秒之间的整数。");
  }
  return duration;
}

function ratioFor(value) {
  const ratio = first(value, "16:9");
  if (!RATIOS.includes(ratio)) {
    throw new Error("当前模型不支持该画幅比例，请选择：" + RATIOS.join("、") + "。");
  }
  return ratio;
}

function resolutionFor(value) {
  const resolution = first(value, "720p").toLowerCase();
  if (!RESOLUTIONS.includes(resolution)) {
    throw new Error("当前模型不支持该分辨率，请选择：" + RESOLUTIONS.join("、") + "。");
  }
  return resolution;
}

function videoInputFor(request) {
  return asArray(object(request).videos).length > 0 ? "present" : "none";
}

function booleanFor(value, field) {
  if (typeof value !== "boolean") throw new Error(field + "参数无效，请使用 true 或 false。");
  return value;
}

function contentText(content) {
  if (!Array.isArray(content)) return "";
  return content
    .filter((item) => item && typeof item === "object" && item.type === "text")
    .map((item) => text(item.text))
    .filter(Boolean)
    .join("\n");
}

function normalizeContent(value, prompt) {
  if (value !== undefined && !Array.isArray(value)) throw new Error("content 必须是数组。");
  const content = Array.isArray(value) ? value.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("content 中的项目格式无效。");
    return Object.assign({}, item);
  }) : [];
  if (prompt && !contentText(content)) content.unshift({ type: "text", text: prompt });
  return content;
}

function normalizeModel(model, upstreamModel) {
  const result = first(upstreamModel, model);
  if (!result) throw new Error("model 是必填参数。");
  return result;
}

function payloadFor(request, model, upstreamModel) {
  const req = object(request);
  const metadata = parseMetadata(req.metadata);
  const all = Object.assign({}, metadata, req);
  const upstream = normalizeModel(model, upstreamModel);
  const prompt = first(all.prompt);
  const content = normalizeContent(all.content, prompt);
  const images = dedupeMedia(
    mediaItems(
      [
        ...asArray(all.images),
        ...asArray(all.image_urls),
        ...asArray(all.referenceImages),
        ...asArray(all.reference_images),
      ],
      "参考图片",
      "reference_image",
    ).concat(
      first(all.firstFrame, all.first_frame)
        ? [httpsURL(first(all.firstFrame, all.first_frame), "首帧", "first_frame")]
        : [],
      first(all.lastFrame, all.last_frame)
        ? [httpsURL(first(all.lastFrame, all.last_frame), "尾帧", "last_frame")]
        : [],
    ),
  );
  const videos = dedupeMedia(
    mediaItems(
      [
        ...asArray(all.videos),
        ...asArray(all.video_urls),
        ...asArray(all.referenceVideos),
        ...asArray(all.reference_videos),
      ],
      "参考视频",
      "reference_video",
    ),
  );
  const audios = dedupeMedia(
    mediaItems(
      [
        ...asArray(all.audios),
        ...asArray(all.audio_urls),
        ...asArray(all.referenceAudios),
        ...asArray(all.reference_audios),
      ],
      "参考音频",
      "reference_audio",
    ),
  );
  if (images.length > MAX_IMAGES) throw new Error("参考图片过多，当前最多支持 30 张。");
  if (videos.length > MAX_VIDEOS) throw new Error("参考视频过多，当前最多支持 10 个。");
  if (audios.length > MAX_AUDIOS) throw new Error("参考音频过多，当前最多支持 10 段。");
  if (!prompt && !content.length && !images.length && !videos.length && !audios.length) {
    throw new Error("请输入提示词，或添加参考图片、视频、音频。");
  }
  if (first(all.lastFrame, all.last_frame) && !first(all.firstFrame, all.first_frame)) {
    throw new Error("请先提供首帧，再提供尾帧。");
  }

  const body = { model: upstream };
  if (content.length) body.content = content;
  else if (prompt) body.prompt = prompt;
  if (images.length) body.images = images;
  if (videos.length) body.videos = videos;
  if (audios.length) body.audios = audios;

  const duration = durationFor(all.duration !== undefined ? all.duration : all.seconds);
  body.duration = duration;
  body.ratio = ratioFor(first(all.ratio, all.aspect_ratio));
  body.resolution = resolutionFor(first(all.resolution, all.quality, all.vquality));

  const generateAudio = all.generateAudio !== undefined ? all.generateAudio : all.generate_audio;
  if (generateAudio !== undefined && generateAudio !== null && generateAudio !== "") {
    body.generate_audio = booleanFor(generateAudio, "音频开关");
  }
  const outputFormat = first(all.output_format, all.outputFormat, "mp4").toLowerCase();
  if (!["mp4", "mov"].includes(outputFormat)) throw new Error("输出格式只支持 mp4 或 mov。");
  body.output_format = outputFormat;

  const taskType = first(all.omni_reference_task_type, all.omniReferenceTaskType);
  if (taskType) {
    if (!TASK_TYPES.includes(taskType)) throw new Error("omni_reference_task_type 只支持 auto、edit 或 extend。");
    body.omni_reference_task_type = taskType;
  }

  if (all.seed !== undefined && all.seed !== null && all.seed !== "") body.seed = integer(all.seed, "随机种子");
  for (const [source, target, label] of [
    ["web_search", "web_search", "联网搜索"],
    ["camera_fixed", "camera_fixed", "固定镜头"],
    ["return_last_frame", "return_last_frame", "返回尾帧"],
    ["watermark", "watermark", "水印"],
  ]) {
    if (all[source] !== undefined && all[source] !== null && all[source] !== "") {
      body[target] = booleanFor(all[source], label);
    }
  }
  return body;
}

function parseMultipart(ctx) {
  const req = {};
  const fields = ctx.body.fields || {};
  for (const key of Object.keys(fields)) {
    if (!Array.isArray(fields[key]) || fields[key].length !== 1) throw new Error("参数重复提交，请检查“" + key + "”。");
    req[key] = fields[key][0];
  }
  for (const key of [
    "metadata",
    "content",
    "images",
    "image_urls",
    "videos",
    "video_urls",
    "audios",
    "audio_urls",
    "referenceImages",
    "reference_images",
    "referenceVideos",
    "reference_videos",
    "referenceAudios",
    "reference_audios",
    "seed",
    "generateAudio",
    "generate_audio",
    "omni_reference_task_type",
    "camera_fixed",
    "return_last_frame",
    "watermark",
  ]) {
    if (req[key] === undefined) continue;
    try {
      req[key] = JSON.parse(req[key]);
    } catch (_error) {
      throw new Error("参数“" + key + "”格式不正确，请提供有效的 JSON。");
    }
  }
  if ((ctx.body.files || []).length) {
    throw new Error("当前上游要求素材使用无需登录即可访问的 HTTPS URL，不支持直接上传文件。");
  }
  return req;
}

export function decodeRequest(ctx) {
  if (!ctx.body || !["json", "multipart"].includes(ctx.body.kind)) {
    throw new Error("请求格式不正确，请使用 JSON 或 multipart/form-data 提交。");
  }
  let req;
  if (ctx.body.kind === "json") {
    if (!ctx.body.value || typeof ctx.body.value !== "object" || Array.isArray(ctx.body.value)) {
      throw new Error("请求内容格式不正确，请提交一个 JSON 对象。");
    }
    req = Object.assign({}, ctx.body.value);
  } else {
    req = parseMultipart(ctx);
  }
  if (req.callback_url !== undefined && req.callback_url !== null && req.callback_url !== "") {
    throw new Error("当前模型不支持回调地址，请移除 callback_url，并通过任务列表或 GET /v1/videos/{id} 查询结果。");
  }
  delete req.callback_url;
  const body = payloadFor(req, ctx.model, ctx.upstreamModel);
  return {
    kind: "submit",
    model: ctx.model,
    action: body.images || body.videos || body.audios ? "image_to_video" : "text_to_video",
    requestBody: body,
  };
}

function base(ctx) {
  return text(ctx.baseUrl).replace(/\/+$/, "");
}

export function buildSubmitRequest(ctx) {
  const body = payloadFor(ctx.requestBody, ctx.model, ctx.upstreamModel);
  return {
    url: base(ctx) + "/api/v3/contents/generations/tasks",
    method: "POST",
    headers: {
      Authorization: "Bearer " + ctx.apiKey,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body,
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
  if (["failed", "cancelled", "expired"].includes(text(body.status).toLowerCase())) {
    throw new Error(errorMessage(body));
  }
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
  if (!Number.isFinite(progress)) return "0%";
  return Math.max(0, Math.min(99, Math.floor(progress))) + "%";
}

export function parseTaskResult(_ctx, value) {
  const body = taskBody(value);
  const status = text(body.status).toLowerCase();
  if (status === "queued" || status === "pending" || status === "submitted") {
    return { status: "QUEUED", progress: progressFor(body, false) };
  }
  if (status === "running" || status === "processing" || status === "in_progress") {
    return { status: "IN_PROGRESS", progress: progressFor(body, false) };
  }
  if (status === "succeeded" || status === "completed" || status === "success" || status === "done") {
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
  if (["failed", "cancelled", "expired"].includes(status)) {
    return { status: "FAILURE", progress: "100%", reason: errorMessage(body) };
  }
  return { status: "UNKNOWN", reason: "暂时无法识别视频任务状态，请稍后查询，无需重新提交。" };
}

function secondsFor(request) {
  const seconds = Number(object(request).duration);
  return seconds === -1 ? MAX_DURATION : Number.isInteger(seconds) && seconds >= 4 && seconds <= MAX_DURATION ? seconds : DEFAULT_DURATION;
}

function resolutionFrom(value) {
  const resolution = text(object(value).content && object(value).content.resolution) || text(object(value).resolution);
  return RESOLUTIONS.includes(resolution.toLowerCase()) ? resolution.toLowerCase() : "";
}

export function extractUsage(ctx) {
  const request = object(ctx.requestBody);
  return {
    seconds: secondsFor(request),
    resolution: resolutionFrom(request) || resolutionFor(request.resolution),
    video_input: videoInputFor(request),
  };
}

export function extractUsageOnComplete(_task, _taskResult, body) {
  const value = taskBody(body);
  if (text(value.status).toLowerCase() !== "succeeded") return {};
  const duration = Number(value.duration);
  const facts = {};
  if (Number.isInteger(duration) && duration >= 4 && duration <= MAX_DURATION) facts.seconds = duration;
  const resolution = resolutionFrom(value);
  if (resolution) facts.resolution = resolution;
  const videoInput = text(value.video_input).toLowerCase();
  if (VIDEO_INPUTS.includes(videoInput)) facts.video_input = videoInput;
  const usage = object(value.usage);
  const completionTokens = Number(usage.completion_tokens || 0);
  if (Number.isFinite(completionTokens) && completionTokens > 0) facts.upstreamUnits = completionTokens;
  return facts;
}

export function listArtifacts(task) {
  if (task.status !== "SUCCESS" || !resultURL(task.data)) return [];
  const format = first(object(task.data).output_format, object(object(task.data).content).output_format, "mp4").toLowerCase();
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
        NOT_START: "queued",
        SUBMITTED: "queued",
        QUEUED: "queued",
        IN_PROGRESS: "in_progress",
        SUCCESS: "completed",
        FAILURE: "failed",
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
