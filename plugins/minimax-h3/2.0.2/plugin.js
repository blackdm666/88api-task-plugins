export const meta = {
  apiVersion: 1,
  key: "minimax-h3",
  name: "Minimax-H3",
  description: {
    en: "88API channel integration plugin",
    zh: "88API渠道集成插件",
  },
  version: "2.0.2",
  author: { name: "88API" },
  // Internal routing identity. The DMC upstream model remains MiniMax-H3 in
  // buildSubmitRequest; keeping the registry name unique lets this plugin
  // coexist with NewAPI's built-in hailuo plugin.
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
  },
  usageExamples: [
    { label: "768P 1s", facts: { seconds: 1 } },
    { label: "768P 5s", facts: { seconds: 5 } },
    { label: "768P 15s", facts: { seconds: 15 } },
  ],
};

const MODEL = "MiniMax-H3";
const DEFAULT_DURATION = 5;
const MIN_DURATION = 1;
const MAX_DURATION = 15;
const MAX_REFERENCE_IMAGES = 9;
const MAX_REFERENCE_VIDEOS = 3;
const MAX_REFERENCE_AUDIOS = 3;
const MAX_MEDIA_ITEMS = 12;
const RATIOS = ["adaptive", "21:9", "16:9", "4:3", "1:1", "3:4", "9:16"];

function trimmed(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizedBaseUrl(value) {
  const baseUrl = trimmed(value).replace(/\/+$/, "");
  if (!baseUrl) throw new Error("视频服务尚未配置访问地址，请联系管理员。");
  return baseUrl;
}

function asArray(value) {
  if (value === undefined || value === null || value === "") return [];
  return Array.isArray(value) ? value : [value];
}

function firstValues() {
  for (const value of arguments) {
    const values = asArray(value).filter(function (item) {
      return item !== undefined && item !== null && item !== "";
    });
    if (values.length) return values;
  }
  return [];
}

function urlPayload(value, field) {
  const label = { image_url: "图片", video_url: "视频", audio_url: "音频" }[field] || "素材";
  if (typeof value === "string") {
    const url = value.trim();
    if (!url) throw new Error(label + "地址不能为空，请提供有效的素材链接。");
    return { url: url };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(label + "格式不正确，请提供素材链接或有效的文件引用。");
  }
  if (Object.prototype.hasOwnProperty.call(value, "url")) {
    if (typeof value.url === "string" && !value.url.trim()) throw new Error(label + "地址不能为空，请提供有效的素材链接。");
    return { url: value.url };
  }
  // NewAPI resolves request-file placeholders after the plugin returns the body.
  return { url: value };
}

function mediaItem(type, value, role) {
  const item = { type: type, role: role };
  item[type] = urlPayload(value, type);
  return item;
}

function normalizeContentItem(item) {
  if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("素材内容格式不正确，请使用包含类型和内容的对象。");
  if (item.type === "text") return { type: "text", text: trimmed(item.text) };
  if (item.type === "image_url") return mediaItem("image_url", item.image_url, trimmed(item.role));
  if (item.type === "video_url") return mediaItem("video_url", item.video_url, trimmed(item.role));
  if (item.type === "audio_url") return mediaItem("audio_url", item.audio_url, trimmed(item.role));
  throw new Error("不支持该素材类型，请使用文本、图片、视频或音频。");
}

function normalizeMediaEntry(entry) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error("素材条目格式不正确，请提供素材类型和链接。");
  const role = trimmed(entry.role) || trimmed(entry.type);
  const value = entry.url !== undefined ? entry.url : entry.uri;
  if (role === "first_frame" || role === "last_frame" || role === "reference_image") {
    return mediaItem("image_url", entry.image_url !== undefined ? entry.image_url : value, role);
  }
  if (role === "reference_video") {
    return mediaItem("video_url", entry.video_url !== undefined ? entry.video_url : value, role);
  }
  if (role === "reference_audio") {
    return mediaItem("audio_url", entry.audio_url !== undefined ? entry.audio_url : value, role);
  }
  if (entry.type === "image_url" || entry.type === "video_url" || entry.type === "audio_url") {
    return normalizeContentItem(entry);
  }
  throw new Error("素材用途无效，请指定首帧、尾帧、参考图片、参考视频或参考音频。");
}

function appendItems(target, type, role, values) {
  for (const value of values) target.push(mediaItem(type, value, role));
}

function assembledContent(req) {
  const metadata = req.metadata && typeof req.metadata === "object" && !Array.isArray(req.metadata) ? req.metadata : {};
  if (metadata.content !== undefined && metadata.content !== null) {
    if (!Array.isArray(metadata.content)) throw new Error("素材列表格式不正确，metadata.content 必须是数组。");
    const content = metadata.content.map(normalizeContentItem);
    if (!content.some(function (item) { return item.type === "text"; }) && trimmed(req.prompt)) {
      content.unshift({ type: "text", text: trimmed(req.prompt) });
    }
    return content;
  }

  const content = [];
  if (trimmed(req.prompt)) content.push({ type: "text", text: trimmed(req.prompt) });

  if (Array.isArray(req.media) && req.media.length) {
    for (const item of req.media) content.push(normalizeMediaEntry(item));
    return content;
  }

  const firstFrame = firstValues(metadata.first_frame_image, metadata.firstFrame, metadata.first_image);
  const lastFrame = firstValues(metadata.last_frame_image, metadata.lastFrame, metadata.last_image);
  if (firstFrame.length || lastFrame.length) {
    appendItems(content, "image_url", "first_frame", firstFrame);
    appendItems(content, "image_url", "last_frame", lastFrame);
  } else {
    const frames = firstValues(req.images, req.image, req.input_reference);
    if (frames.length > 0) content.push(mediaItem("image_url", frames[0], "first_frame"));
    if (frames.length > 1) content.push(mediaItem("image_url", frames[1], "last_frame"));
    if (frames.length > 2) throw new Error("首尾帧模式最多支持 2 张图片，请分别提供首帧和尾帧。");
  }

  appendItems(content, "image_url", "reference_image", firstValues(metadata.reference_images, metadata.referenceImages, metadata.reference_image));
  appendItems(content, "video_url", "reference_video", firstValues(req.videos, req.video, metadata.reference_videos, metadata.referenceVideos, metadata.reference_video));
  appendItems(content, "audio_url", "reference_audio", firstValues(metadata.reference_audios, metadata.referenceAudios, metadata.reference_audio));
  return content;
}

function validateContent(content) {
  let textCount = 0;
  let firstFrames = 0;
  let lastFrames = 0;
  let referenceImages = 0;
  let referenceVideos = 0;
  let referenceAudios = 0;
  let unroledImages = [];

  for (let index = 0; index < content.length; index += 1) {
    const item = content[index];
    if (item.type === "text") {
      textCount += 1;
      if (!item.text) throw new Error("提示词不能为空，请输入视频内容描述。");
      continue;
    }
    if (item.type === "image_url") {
      if (!item.role) unroledImages.push(index);
      else if (item.role === "first_frame") firstFrames += 1;
      else if (item.role === "last_frame") lastFrames += 1;
      else if (item.role === "reference_image") referenceImages += 1;
      else throw new Error("图片用途无效，请设置为首帧、尾帧或参考图片。");
      continue;
    }
    if (item.type === "video_url") {
      if (item.role !== "reference_video") throw new Error("视频素材仅支持作为参考视频，请将用途设为 reference_video。");
      referenceVideos += 1;
      continue;
    }
    if (item.type === "audio_url") {
      if (item.role !== "reference_audio") throw new Error("音频素材仅支持作为参考音频，请将用途设为 reference_audio。");
      referenceAudios += 1;
    }
  }

  if (textCount !== 1) throw new Error("请输入一段非空提示词；每次请求只能包含一段提示词。");
  if (unroledImages.length) {
    const totalImages = firstFrames + lastFrames + referenceImages + unroledImages.length;
    if (unroledImages.length !== 1 || totalImages !== 1) throw new Error("多张图片需要指定用途，请标明首帧、尾帧或参考图片。");
    content[unroledImages[0]].role = "first_frame";
    firstFrames += 1;
  }
  if (firstFrames > 1 || lastFrames > 1) throw new Error("首帧和尾帧各最多 1 张，请删除重复图片。");
  if (referenceImages > MAX_REFERENCE_IMAGES) throw new Error("参考图片最多 9 张，请减少后提交。");
  if (referenceVideos > MAX_REFERENCE_VIDEOS) throw new Error("参考视频最多 3 个，请减少后提交。");
  if (referenceAudios > MAX_REFERENCE_AUDIOS) throw new Error("参考音频最多 3 段，请减少后提交。");

  const frameCount = firstFrames + lastFrames;
  const referenceCount = referenceImages + referenceVideos + referenceAudios;
  if (frameCount && referenceCount) throw new Error("首尾帧不能与参考素材混用，请选择首尾帧模式或参考素材模式。");
  if (frameCount + referenceCount > MAX_MEDIA_ITEMS) throw new Error("参考素材合计最多 12 个，请减少图片、视频或音频数量。");
  return content;
}

function durationFor(req) {
  const raw = req.duration !== undefined && req.duration !== null && req.duration !== "" ? req.duration : req.seconds;
  if (raw === undefined || raw === null || raw === "") return DEFAULT_DURATION;
  const duration = Number(raw);
  if (!Number.isInteger(duration) || duration < MIN_DURATION || duration > MAX_DURATION) {
    throw new Error("视频时长需为 1 到 15 秒之间的整数，请调整后提交。");
  }
  return duration;
}

function resolutionFor(req) {
  const metadata = req.metadata && typeof req.metadata === "object" && !Array.isArray(req.metadata) ? req.metadata : {};
  const raw = trimmed(metadata.resolution) || trimmed(req.resolution) || trimmed(req.size);
  if (!raw || raw.toUpperCase().includes("768")) return "768P";
  throw new Error("当前模型仅支持 768P 分辨率，请选择 768P。");
}

function hasVisual(content) {
  return content.some(function (item) { return item.type === "image_url" || item.type === "video_url"; });
}

function hasMedia(content) {
  return content.some(function (item) { return item.type !== "text"; });
}

function hasReference(content) {
  return content.some(function (item) { return item.role === "reference_image" || item.role === "reference_video" || item.role === "reference_audio"; });
}

function ratioFor(req, content) {
  const metadata = req.metadata && typeof req.metadata === "object" && !Array.isArray(req.metadata) ? req.metadata : {};
  const ratio = trimmed(metadata.ratio) || trimmed(metadata.aspect_ratio) || trimmed(req.ratio) || "16:9";
  if (!RATIOS.includes(ratio)) throw new Error("当前模型不支持该画幅比例，请选择：" + RATIOS.join("、") + "。");
  if (ratio === "adaptive" && !hasVisual(content)) throw new Error("自适应比例需要图片或视频，请添加视觉素材，或选择具体画幅比例。");
  return ratio;
}

function apiError(body) {
  const error = body && typeof body === "object" && !Array.isArray(body) ? body.error : null;
  if (!error || typeof error !== "object" || Array.isArray(error)) return null;
  const message = trimmed(error.message);
  if (!message) return null;
  const code = trimmed(error.type) || trimmed(error.code) || "upstream_error";
  const statusCode = Number(error.http_code || 0);
  return { code: code, message: message, statusCode: Number.isInteger(statusCode) ? statusCode : 0 };
}

function queryTask(body) {
  const task = body && typeof body === "object" && !Array.isArray(body) ? body.task : null;
  return task && typeof task === "object" && !Array.isArray(task) ? task : null;
}

function taskProgress(task, terminal) {
  if (terminal) return "100%";
  if (task.status === "queued") return "0%";
  const progress = Number(task.progress);
  if (Number.isFinite(progress) && progress >= 0 && progress <= 1) {
    return Math.min(99, Math.round(progress * 100)) + "%";
  }
  return "50%";
}


// Preserve the old internal H3 alias when replaying existing channel mappings.
function upstreamModelFor(ctx) {
  const name = trimmed(ctx.upstreamModel) || trimmed(ctx.model);
  return !name || name === "dmc-minimax-h3" || name === "minimax-h3-768p" ? MODEL : name;
}
function h3(ctx) { return upstreamModelFor(ctx) === MODEL; }
function genericDuration(req) {
  const value = req.duration !== undefined ? req.duration : req.seconds;
  const n = Number(value);
  if ((typeof value !== "number" && typeof value !== "string") || !Number.isSafeInteger(n) || n <= 0) throw new Error("请明确填写视频时长，时长必须是正整数秒数。");
  return n;
}

export function buildSubmitRequest(ctx) {
  const req = ctx.requestBody || {};
  const content = h3(ctx) ? validateContent(assembledContent(req)) : assembledContent(req);
  const body = {
    model: upstreamModelFor(ctx),
    content: content,
    resolution: h3(ctx) ? resolutionFor(req) : trimmed(req.resolution) || trimmed((req.metadata || {}).resolution),
    duration: h3(ctx) ? durationFor(req) : genericDuration(req),
    ratio: h3(ctx) ? ratioFor(req, content) : trimmed(req.ratio) || trimmed((req.metadata || {}).ratio),
  };
  if (!body.resolution) delete body.resolution;
  if (!body.ratio) delete body.ratio;
  const headers = {
    "Content-Type": "application/json",
    Accept: "application/json",
    Authorization: "Bearer " + ctx.apiKey,
  };
  const idempotencyKey = trimmed(ctx.publicTaskId);
  if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
  const action = hasReference(content) ? "reference_to_video" : hasMedia(content) ? "image_to_video" : "text_to_video";
  return { url: normalizedBaseUrl(ctx.baseUrl) + "/v2/video_generation", method: "POST", headers: headers, body: body, action: action };
}

export function parseSubmitResponse(_ctx, response) {
  const body = response.body || {};
  const error = apiError(body);
  if (error) throw new Error(error.code + ": " + error.message);
  const taskId = trimmed(body.task_id);
  if (!taskId) throw new Error("视频服务未返回任务编号，请联系管理员确认是否已受理，勿重复提交。");
  return { taskId: taskId, taskData: body };
}

export function extractUsage(ctx) {
  if (ctx.usagePurpose === "billing_ratios") return null;
  return { seconds: h3(ctx) ? durationFor(ctx.requestBody || {}) : genericDuration(ctx.requestBody || {}) };
}

export function buildQueryRequest(ctx) {
  return {
    url: normalizedBaseUrl(ctx.baseUrl) + "/v2/query/video_generation/" + encodeURIComponent(ctx.taskId),
    method: "GET",
    headers: { Accept: "application/json", Authorization: "Bearer " + ctx.apiKey },
  };
}

export function parseTaskResult(_ctx, body) {
  const error = apiError(body);
  if (error) {
    if (error.statusCode === 408 || error.statusCode === 429 || error.statusCode >= 500) throw new Error(error.code + ": " + error.message);
    return { code: error.statusCode, status: "FAILURE", progress: "100%", reason: error.code + ": " + error.message };
  }
  const task = queryTask(body);
  if (!task) throw new Error("暂未获取到视频任务信息，请稍后查询，无需重新提交生成。");
  const statuses = { queued: "QUEUED", running: "IN_PROGRESS", succeeded: "SUCCESS", failed: "FAILURE", cancelled: "FAILURE" };
  const status = statuses[task.status];
  if (!status) return { status: "UNKNOWN", reason: "暂时无法识别视频任务状态，请稍后查询，无需重新提交生成。" };
  const result = { code: 0, status: status, progress: taskProgress(task, status === "SUCCESS" || status === "FAILURE") };
  if (status === "SUCCESS") {
    const url = trimmed(task.content && task.content.url);
    if (url) result.url = url;
  }
  if (status === "FAILURE") {
    const taskError = task.error && typeof task.error === "object" && !Array.isArray(task.error) ? task.error : {};
    const code = trimmed(taskError.code) || "task_" + task.status;
    const message = trimmed(taskError.message);
    // Preserve provider details exactly as before; localize only our fallback.
    const fallback = task.status === "cancelled" ? "视频任务已取消。" : "视频生成失败，服务端未提供具体原因，请联系管理员。";
    result.reason = message ? code + ": " + message : (trimmed(taskError.code) ? code + ": " : "") + fallback;
  }
  return result;
}

export function listArtifacts(task) {
  if (task.status !== "SUCCESS") return [];
  const source = task.data && typeof task.data === "object" ? task.data : {};
  const body = source.data && typeof source.data === "object" ? source.data : source;
  const item = queryTask(body);
  const url = trimmed(item && item.content && item.content.url);
  return url ? [{ key: "video", type: "video", mimeType: "video/mp4" }] : [];
}

export function buildContentRequest(ctx) {
  if (ctx.artifactKey !== "video") throw new Error("未找到所请求的视频资源，请检查任务和资源类型。");
  const source = ctx.data && typeof ctx.data === "object" ? ctx.data : {};
  const body = source.data && typeof source.data === "object" ? source.data : source;
  const task = queryTask(body);
  const url = trimmed(task && task.content && task.content.url);
  if (!url) throw new Error("视频结果暂不可用，请稍后查询任务；若任务已完成仍无法获取，请联系管理员。");
  return { url: url, method: ctx.clientRequest.method, credentialless: true };
}

export function extractUsageOnComplete(_task, _taskResult, body) {
  const task = queryTask(body);
  if (!task) return null;
  const usage = task.usage && typeof task.usage === "object" && !Array.isArray(task.usage) ? task.usage : {};
  const seconds = Number(usage.output_seconds !== undefined ? usage.output_seconds : task.duration);
  if (!Number.isInteger(seconds) || seconds < MIN_DURATION) return null;
  return { seconds: seconds };
}

function renderOpenAIVideo(task) {
  const statuses = {
    NOT_START: "queued",
    SUBMITTED: "queued",
    QUEUED: "queued",
    IN_PROGRESS: "in_progress",
    SUCCESS: "completed",
    FAILURE: "failed",
  };
  const output = {
    id: task.task_id,
    object: "video",
    model: task.properties && task.properties.origin_model_name ? task.properties.origin_model_name : "",
    status: statuses[task.status] || "unknown",
    progress: Number(String(task.progress || "0").replace("%", "")),
    created_at: task.created_at,
  };
  if (task.updated_at) output.completed_at = task.updated_at;
  if (task.status === "FAILURE") {
    output.error = { code: "dmc_task_failed", message: task.fail_reason || "视频生成失败，服务端未提供具体原因，请联系管理员。" };
  }
  return output;
}

export const protocols = {
  openai_video: {
    decodeRequest: function (ctx) {
      if (!ctx.body || (ctx.body.kind !== "json" && ctx.body.kind !== "multipart")) {
        throw new Error("请求格式不正确，请使用 JSON 或 multipart 提交。");
      }
      let request;
      if (ctx.body.kind === "json") {
        if (!ctx.body.value || typeof ctx.body.value !== "object" || Array.isArray(ctx.body.value)) throw new Error("请求内容必须是 JSON 对象，请检查提交格式。");
        request = Object.assign({}, ctx.body.value);
      } else {
        if ((ctx.body.files || []).length) throw new Error("当前视频服务不支持直接上传文件，请先上传素材并提供可公开访问的 HTTPS 链接。");
        request = {};
        const fields = ctx.body.fields || {};
        for (const name of Object.keys(fields)) {
          const values = fields[name] || [];
          if (values.length > 1) throw new Error("参数重复提交：" + name + "，请只保留一个值。");
          request[name] = values[0];
        }
        if (request.metadata !== undefined) {
          let parsed;
          try {
            parsed = JSON.parse(request.metadata);
          } catch (_error) {
            throw new Error("metadata 参数格式不正确，请传入有效的 JSON 对象字符串。");
          }
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("metadata 参数格式不正确，请传入有效的 JSON 对象字符串。");
          request.metadata = parsed;
        }
      }
      if (request.seconds !== undefined && request.duration === undefined) request.duration = Number(request.seconds);
      if (request.duration !== undefined) request.duration = Number(request.duration);
      request.model = ctx.model;
      const content = h3(ctx) ? validateContent(assembledContent(request)) : assembledContent(request);
      const action = hasReference(content) ? "reference_to_video" : hasMedia(content) ? "image_to_video" : "text_to_video";
      // Validate the exact DMC contract before channel selection and billing.
      if (h3(ctx)) {
        durationFor(request);
        resolutionFor(request);
        ratioFor(request, content);
      } else { genericDuration(request); }
      return { kind: "submit", model: ctx.model, action: action, requestBody: request };
    },
    render: function (_ctx, task) {
      return renderOpenAIVideo(task);
    },
  },
};
