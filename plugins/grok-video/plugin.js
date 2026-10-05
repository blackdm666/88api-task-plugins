const MODEL = "grok-imagine-video-1.5";
const DEFAULT_DURATION = 8;
const MIN_DURATION = 1;
const MAX_DURATION = 15;
const DEFAULT_RATIO = "16:9";
const RATIOS = ["16:9", "9:16", "1:1", "4:3", "3:4", "3:2", "2:3"];
const RESOLUTIONS = ["480p", "720p", "1080p"];

function object(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

function first(...values) {
  for (const value of values) {
    const result = text(value);
    if (result) return result;
  }
  return "";
}

function metadataFor(value) {
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

function parseMultipart(ctx) {
  if (Array.isArray(ctx.body.files) && ctx.body.files.length > 0) {
    throw new Error("当前模型不支持直接上传文件，请提供可被上游访问的 HTTPS 图片地址。");
  }
  const request = {};
  const fields = object(ctx.body.fields);
  for (const name of Object.keys(fields)) {
    const values = Array.isArray(fields[name]) ? fields[name] : [fields[name]];
    if (values.length > 1) throw new Error("参数重复提交：" + name + "，请只保留一个值。");
    request[name] = values[0];
  }
  if (request.metadata !== undefined) request.metadata = metadataFor(request.metadata);
  return request;
}

function durationFor(request) {
  const value = request.duration !== undefined ? request.duration : request.seconds;
  if (value === undefined || value === null || value === "") return DEFAULT_DURATION;
  const duration = Number(value);
  if (!Number.isInteger(duration) || duration < MIN_DURATION || duration > MAX_DURATION) {
    throw new Error("视频时长需为 1 到 15 秒之间的整数。");
  }
  return duration;
}

function resolutionFor(request) {
  const metadata = metadataFor(request.metadata);
  let resolution = first(request.resolution, request.quality, request.vquality, metadata.resolution).toLowerCase();
  if (!resolution) resolution = "720p";
  if (!resolution.endsWith("p")) resolution += "p";
  if (!RESOLUTIONS.includes(resolution)) {
    throw new Error("当前模型不支持该分辨率，请选择：480p、720p 或 1080p。");
  }
  return resolution;
}

function ratioFor(request) {
  const metadata = metadataFor(request.metadata);
  const ratio = first(request.aspect_ratio, request.size, metadata.aspect_ratio) || DEFAULT_RATIO;
  if (!RATIOS.includes(ratio)) {
    throw new Error("当前模型不支持该画幅比例，请选择：" + RATIOS.join("、") + "。");
  }
  return ratio;
}

function imageURL(value) {
  if (typeof value === "string") return text(value);
  if (value && typeof value === "object" && !Array.isArray(value)) return text(value.url);
  return "";
}

function imageFor(request) {
  const candidates = [];
  for (const key of ["image", "input_reference", "image_url"]) {
    if (request[key] !== undefined && request[key] !== null && request[key] !== "") {
      candidates.push(request[key]);
    }
  }
  for (const key of ["images", "image_urls"]) {
    if (Array.isArray(request[key])) candidates.push(...request[key]);
    else if (request[key] !== undefined && request[key] !== null && request[key] !== "") candidates.push(request[key]);
  }
  const urls = candidates.map(imageURL).filter(Boolean);
  if (urls.length > 1) throw new Error("Grok 视频单次最多接受一张输入图片。");
  if (!urls[0]) return null;
  if (!/^https:\/\//i.test(urls[0])) {
    throw new Error("输入图片必须是可被上游访问的 HTTPS 地址。");
  }
  return urls[0];
}

function normalizeRequest(request, model) {
  const duration = durationFor(request);
  const resolution = resolutionFor(request);
  const aspectRatio = ratioFor(request);
  const image = imageFor(request);
  const prompt = text(request.prompt);
  if (!prompt && !image) throw new Error("请输入提示词或提供一张输入图片。");
  const body = {
    model,
    prompt,
    duration,
    aspect_ratio: aspectRatio,
    resolution,
  };
  if (image) body.image = { url: image };
  return body;
}

function base(ctx) {
  return text(ctx.baseUrl).replace(/\/+$/, "");
}

function taskBody(value) {
  const body = object(value);
  if (
    body.status !== undefined ||
    body.request_id ||
    body.task_id ||
    body.id ||
    body.video ||
    body.error
  ) return body;
  return object(body.data);
}

function errorMessage(body) {
  const error = object(body.error);
  return first(error.message, typeof body.error === "string" ? body.error : "", body.message, "视频生成失败，请稍后重试。");
}

function resultURL(value) {
  const body = taskBody(value);
  return first(
    object(body.video).url,
    body.video_url,
    object(object(body.data).video).url,
  );
}

function absoluteURL(baseUrl, value) {
  const raw = text(value);
  if (!raw) return "";
  if (/^https?:\/\//i.test(raw)) return raw;
  return new URL(raw, baseUrl.replace(/\/+$/, "") + "/").toString();
}

function progressFor(value, terminal) {
  if (terminal) return "100%";
  const number = Number(String(value === undefined ? 0 : value).replace(/%$/, ""));
  if (!Number.isFinite(number)) return "0%";
  return Math.max(0, Math.min(99, Math.floor(number))) + "%";
}

function resolutionFrom(value) {
  const body = taskBody(value);
  const video = object(body.video);
  const resolution = first(body.resolution, video.resolution).toLowerCase();
  return RESOLUTIONS.includes(resolution) ? resolution : "";
}

function secondsFrom(value) {
  const body = taskBody(value);
  const video = object(body.video);
  const raw = body.duration !== undefined ? body.duration : video.duration;
  const seconds = Number(raw);
  return Number.isInteger(seconds) && seconds >= MIN_DURATION && seconds <= MAX_DURATION ? seconds : 0;
}

export const meta = {
  apiVersion: 1,
  key: "grok-video",
  name: "Grok Video",
  version: "1.0.0",
  author: { name: "88API" },
  description: {
    en: "Grok Imagine Video through the Sub2API video task API",
    zh: "通过 Sub2API 视频任务接口接入 Grok Imagine Video",
  },
  models: [MODEL],
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
  },
  usageExamples: [
    { label: "8s · 720p", facts: { seconds: 8, resolution: "720p" } },
    { label: "8s · 1080p", facts: { seconds: 8, resolution: "1080p" } },
  ],
};

export function buildSubmitRequest(ctx) {
  const body = normalizeRequest(ctx.requestBody || {}, ctx.upstreamModel || ctx.model || MODEL);
  return {
    url: base(ctx) + "/v1/videos/generations",
    method: "POST",
    headers: {
      Authorization: "Bearer " + ctx.apiKey,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body,
  };
}

export function parseSubmitResponse(ctx, response) {
  const body = taskBody(response.body);
  if (body.error || ["failed", "cancelled", "expired"].includes(text(body.status).toLowerCase())) {
    throw new Error(errorMessage(body));
  }
  const taskId = first(body.request_id, body.id, body.task_id);
  if (!taskId) throw new Error("视频服务未返回任务编号，请联系管理员确认是否已受理，勿重复提交。");
  return {
    taskId,
    taskData: response.body,
    state: { resolution: resolutionFor(ctx.requestBody || {}) },
  };
}

export function buildQueryRequest(ctx) {
  return {
    url: base(ctx) + "/v1/videos/" + encodeURIComponent(ctx.taskId),
    method: "GET",
    headers: { Authorization: "Bearer " + ctx.apiKey, Accept: "application/json" },
  };
}

export function parseTaskResult(ctx, value, response) {
  const body = taskBody(value);
  const httpStatus = Number(object(response).status);
  if (httpStatus >= 400 && httpStatus < 500) {
    return { status: "FAILURE", progress: "100%", reason: errorMessage(body) };
  }
  const status = text(body.status).toLowerCase();
  if (["queued", "pending"].includes(status)) {
    return { status: "QUEUED", progress: progressFor(body.progress, false) };
  }
  if (["processing", "in_progress", "running"].includes(status)) {
    return { status: "IN_PROGRESS", progress: progressFor(body.progress, false) };
  }
  if (["done", "completed", "succeeded", "success"].includes(status)) {
    const url = absoluteURL(ctx.baseUrl, resultURL(body));
    if (!url) return { status: "FAILURE", progress: "100%", reason: "视频服务报告任务已完成，但未返回视频地址，请联系管理员核查。" };
    return { status: "SUCCESS", progress: "100%", url };
  }
  if (["failed", "cancelled", "expired"].includes(status)) {
    return { status: "FAILURE", progress: "100%", reason: errorMessage(body) };
  }
  return { status: "UNKNOWN", reason: "暂时无法识别视频任务状态，请稍后查询，无需重新提交。" };
}

export function extractUsage(ctx) {
  const request = ctx.requestBody || {};
  return {
    seconds: durationFor(request),
    resolution: resolutionFor(request),
  };
}

export function extractUsageOnComplete(task, _taskResult, value) {
  const body = taskBody(value);
  if (!["done", "completed", "succeeded", "success"].includes(text(body.status).toLowerCase())) return {};
  const facts = {};
  const seconds = secondsFrom(body);
  if (seconds) facts.seconds = seconds;
  const resolution = resolutionFrom(body) || text(object(object(task).state).resolution);
  if (RESOLUTIONS.includes(resolution)) facts.resolution = resolution;
  return facts;
}

export function listArtifacts(task) {
  return task.status === "SUCCESS" && resultURL(task.data)
    ? [{ key: "video", type: "video", mimeType: "video/mp4" }]
    : [];
}

export function buildContentRequest(ctx) {
  const url = absoluteURL(ctx.baseUrl, resultURL(ctx.data));
  if (ctx.artifactKey !== "video" || !url) throw new Error("视频结果暂不可用，请稍后重试。");
  return { url, method: ctx.clientRequest.method, credentialless: true };
}

export const protocols = {
  openai_video: {
    decodeRequest(ctx) {
      if (!ctx.body || !["json", "multipart"].includes(ctx.body.kind)) {
        throw new Error("请求格式不正确，请使用 JSON 或 multipart/form-data 提交。");
      }
      const request = ctx.body.kind === "json"
        ? Object.assign({}, object(ctx.body.value))
        : parseMultipart(ctx);
      const requestBody = normalizeRequest(request, ctx.model || MODEL);
      return {
        kind: "submit",
        model: ctx.model || MODEL,
        action: requestBody.image ? "image_to_video" : "text_to_video",
        requestBody,
      };
    },
    render(_ctx, task) {
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
        model: object(task.properties).origin_model_name || MODEL,
        status: statuses[task.status] || "unknown",
        progress: Number(String(task.progress || "0").replace("%", "")),
        created_at: task.created_at,
      };
      if (task.status === "SUCCESS" || task.status === "FAILURE") result.completed_at = task.updated_at;
      if (task.status === "FAILURE") {
        result.error = {
          code: "video_generation_failed",
          message: task.fail_reason || "视频生成失败，请稍后重试。",
        };
      }
      return result;
    },
  },
};
