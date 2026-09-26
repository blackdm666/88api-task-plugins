// Derived from 88API's DMC Minimax-H3 task plugin for NewAPI / QuantumNous.
// SPDX-License-Identifier: AGPL-3.0-or-later
// This is a separate driver: existing DMC channels and persisted tasks are untouched.
export const meta = {
  apiVersion: 1,
  key: "minimax-h3-async",
  name: "Minimax-H3 Async",
  description: { en: "MiniMax H3 asynchronous video integration", zh: "MiniMax H3 异步视频集成" },
  version: "1.0.0",
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
  },
};

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
    const values = asArray(value);
    if (values.length) return values;
  }
  return [];
}

function integer(value, label, min, max) {
  if ((typeof value !== "number" && typeof value !== "string") || value === "" ||
      (typeof value === "string" && !/^-?\d+$/.test(value.trim()))) {
    throw new Error(label + "必须为整数。");
  }
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < min || number > max) {
    throw new Error(label + "需为 " + min + " 到 " + max + " 之间的整数。");
  }
  return number;
}

function metadataFor(req) {
  if (req.metadata === undefined) return {};
  if (!req.metadata || typeof req.metadata !== "object" || Array.isArray(req.metadata)) {
    throw new Error("metadata 参数必须为 JSON 对象。");
  }
  return req.metadata;
}

function resolutionFor(ctx, req, metadata) {
  const upstream = trimmed(ctx.upstreamModel) || trimmed(ctx.model);
  if (!/^minimax-h3(?:-(480p|768p|1080p))?$/.test(upstream.replace("minimax-h3-async", "minimax-h3"))) {
    throw new Error("当前插件仅支持 MiniMax H3，请管理员检查模型映射。");
  }
  const pin = /-(480p|768p|1080p)$/.exec(upstream);
  const publicPin = /-(480p|768p|1080p)$/.exec(trimmed(ctx.model));
  if (pin && publicPin && pin[1] !== publicPin[1]) {
    throw new Error("模型映射的分辨率与销售型号不一致，请联系管理员。");
  }
  const fixed = (publicPin || pin || [])[1];
  const values = [req.resolution, metadata.resolution];
  if (/^\d+p$/i.test(trimmed(req.size))) values.push(req.size);
  let selected = fixed || "768p";
  let explicit;
  for (const value of values) {
    if (value === undefined) continue;
    const quality = trimmed(value).toLowerCase();
    if (!["480p", "768p", "1080p"].includes(quality)) throw new Error("请选择 480p、768p 或 1080p 分辨率。");
    if ((fixed && quality !== fixed) || (explicit && quality !== explicit)) {
      throw new Error("请求分辨率与销售型号或其他分辨率参数冲突。");
    }
    explicit = quality;
    selected = quality;
  }
  // Unqualified names deliberately stay at 768p; publish other quality tiers
  // under explicit model names, so a request cannot silently bypass tier pricing.
  if (!fixed && selected !== "768p") throw new Error("请使用对应分辨率的模型名称。");
  return selected;
}

function ratioFor(req, metadata) {
  const ratios = { "16:9": "landscape", landscape: "landscape", "9:16": "portrait", portrait: "portrait" };
  const values = [req.ratio, req.aspectRatio, req.aspect_ratio, metadata.ratio, metadata.aspectRatio, metadata.aspect_ratio];
  const size = trimmed(req.size).toLowerCase();
  if (size && !/^\d+p$/.test(size)) {
    const dimensions = /^(\d+)x(\d+)$/.exec(size);
    if (!dimensions) throw new Error("尺寸格式无效，请选择横屏 16:9 或竖屏 9:16。");
    const width = Number(dimensions[1]), height = Number(dimensions[2]);
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0) {
      throw new Error("视频尺寸必须为正整数。");
    }
    if (width * 9 === height * 16) values.push("16:9");
    else if (width * 16 === height * 9) values.push("9:16");
    else throw new Error("当前视频服务仅支持横屏 16:9 或竖屏 9:16。");
  }
  let selected;
  for (const value of values) {
    if (value === undefined) continue;
    const ratio = ratios[trimmed(value)];
    if (!ratio) throw new Error("当前视频服务仅支持横屏 16:9 或竖屏 9:16。");
    if (selected && selected !== ratio) throw new Error("画幅比例参数冲突，请只提供一致的比例。");
    selected = ratio;
  }
  return selected || "landscape";
}

function mediaValue(value) {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (value && typeof value === "object" && !Array.isArray(value)) {
    if (typeof value.url === "string" && value.url.trim()) return value.url.trim();
    // Keep DMC's host-owned file-reference convention, with encoding selected
    // by our decoder rather than reading file bytes in JavaScript.
    if (typeof value.__fileRef === "string" && value.encoding === "dataUrl") {
      return { __fileRef: value.__fileRef, encoding: "dataUrl" };
    }
  }
  throw new Error("素材格式不正确，请提供 URL、Base64 或有效的上传文件。");
}

function normalizedRequest(ctx) {
  const req = ctx.requestBody || {};
  const metadata = metadataFor(req);
  const resolution = resolutionFor(ctx, req, metadata);
  const maxDuration = resolution === "1080p" ? 10 : 15;
  const duration = integer(req.duration !== undefined ? req.duration : req.seconds !== undefined ? req.seconds : 5,
    "视频时长", 1, maxDuration);
  if (req.seconds !== undefined && integer(req.seconds, "视频时长", 1, maxDuration) !== duration) {
    throw new Error("duration 与 seconds 不一致，请统一视频时长。");
  }
  // Never accept a second, unvalidated billing source through metadata.
  for (const value of [metadata.duration, metadata.seconds]) {
    if (value !== undefined && integer(value, "视频时长", 1, maxDuration) !== duration) {
      throw new Error("metadata 与请求的视频时长不一致。");
    }
  }
  for (const name of ["videos", "video", "reference_videos", "referenceVideos", "reference_video",
    "first_frame_image", "firstFrame", "first_image", "last_frame_image", "lastFrame", "last_image"]) {
    if (asArray(req[name]).length || asArray(metadata[name]).length) {
      throw new Error("当前上游仅支持参考图片和参考音频，不支持参考视频或专用首尾帧参数。");
    }
  }
  let prompt = trimmed(req.prompt);
  let images = firstValues(req.images, req.image, req.input_reference,
    metadata.reference_images, metadata.referenceImages, metadata.reference_image).map(mediaValue);
  let audios = firstValues(req.audios, req.audio, metadata.reference_audios,
    metadata.referenceAudios, metadata.reference_audio).map(mediaValue);
  const content = metadata.content !== undefined ? metadata.content : req.content;
  if (content !== undefined || req.media !== undefined) {
    if (images.length || audios.length || (content !== undefined && req.media !== undefined)) {
      throw new Error("请只使用一组素材参数，避免重复或遗漏素材。");
    }
    const entries = content !== undefined ? content : req.media;
    if (!Array.isArray(entries)) throw new Error("素材列表必须是数组。");
    for (const item of entries) {
      if (!item || typeof item !== "object") throw new Error("素材条目格式无效。");
      if (item.type === "text") {
        if (prompt && prompt !== trimmed(item.text)) throw new Error("请只提供一段一致的提示词。");
        prompt = trimmed(item.text);
        continue;
      }
      const role = trimmed(item.role) || trimmed(item.type);
      if (["first_frame", "last_frame", "reference_video", "video_url"].includes(role) || item.type === "video_url") {
        throw new Error("当前上游不支持参考视频或专用首尾帧参数。");
      }
      if (role === "reference_image" || role === "image_url") images.push(mediaValue(item.image_url || item.url || item.uri));
      else if (role === "reference_audio" || role === "audio_url") audios.push(mediaValue(item.audio_url || item.url || item.uri));
      else throw new Error("素材用途无效，请使用参考图片或参考音频。");
    }
  }
  if (!prompt) throw new Error("提示词不能为空，请输入视频内容描述。");
  if (images.length > 9) throw new Error("参考图片最多 9 张，请减少后提交。");
  if (audios.length > 3) throw new Error("参考音频最多 3 段，请减少后提交。");
  const body = { model: "minimax-h3", prompt: prompt, aspectRatio: ratioFor(req, metadata),
    resolution: resolution, duration: duration, replyType: "async" };
  if (images.length) body.images = images;
  if (audios.length) body.audios = audios;
  if (req.seed !== undefined || metadata.seed !== undefined) {
    body.seed = integer(req.seed !== undefined ? req.seed : metadata.seed, "随机种子", -Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER);
    if (metadata.seed !== undefined && integer(metadata.seed, "随机种子", -Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER) !== body.seed) {
      throw new Error("随机种子参数冲突。");
    }
  }
  return body;
}

export function buildSubmitRequest(ctx) {
  const body = normalizedRequest(ctx);
  const headers = { "Content-Type": "application/json", Accept: "application/json", Authorization: "Bearer " + ctx.apiKey };
  // Preserved from the DMC driver as a correlation/idempotency hint. Upstream
  // documentation does not promise deduplication; do not assume safe resubmission.
  if (trimmed(ctx.publicTaskId)) headers["Idempotency-Key"] = ctx.publicTaskId;
  return { url: normalizedBaseUrl(ctx.baseUrl) + "/v1/api/generate", method: "POST", headers: headers,
    body: body, action: body.images || body.audios ? "reference_to_video" : "text_to_video" };
}

export function extractUsage(ctx) {
  if (ctx.usagePurpose === "billing_ratios") return null;
  return { seconds: normalizedRequest(ctx).duration };
}

export function parseSubmitResponse(ctx, response) {
  const body = response.body || {};
  const id = trimmed(body.id);
  if (!id) throw new Error(trimmed(body.error) || "视频服务未返回任务编号，请联系管理员确认是否已受理，勿重复提交。");
  const result = { taskId: id, taskData: body };
  if (["succeeded", "failed", "violation"].includes(body.status)) result.immediate = parseTaskResult({}, body);
  else if (body.status !== "running") throw new Error("暂时无法识别已提交任务的状态，请联系管理员，勿重复提交。");
  return result;
}

export function buildQueryRequest(ctx) {
  if (!trimmed(ctx.taskId)) throw new Error("缺少视频任务编号。");
  return { url: normalizedBaseUrl(ctx.baseUrl) + "/v1/api/result?id=" + encodeURIComponent(ctx.taskId),
    method: "GET", headers: { Accept: "application/json", Authorization: "Bearer " + ctx.apiKey } };
}

function resultURL(body) {
  if (!body || !Array.isArray(body.results)) return "";
  for (const item of body.results) {
    const url = trimmed(item && item.url);
    if (/^https?:\/\//i.test(url)) return url;
  }
  return "";
}

export function parseTaskResult(ctx, body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("视频任务响应格式无效，请稍后查询，无需重新提交。");
  if (ctx.taskId && trimmed(body.id) && trimmed(body.id) !== ctx.taskId) throw new Error("上游返回的任务编号不匹配。");
  const statuses = { running: "IN_PROGRESS", succeeded: "SUCCESS", failed: "FAILURE", violation: "FAILURE" };
  const status = statuses[body.status];
  if (!status) return { status: "UNKNOWN", reason: trimmed(body.error) || "暂时无法识别视频任务状态，请稍后查询，无需重新提交。" };
  if (status === "IN_PROGRESS") {
    const progress = typeof body.progress === "number" ? body.progress : 0;
    return { status: status, progress: Math.min(99, Math.max(0, Number.isFinite(progress) ? Math.floor(progress) : 0)) + "%" };
  }
  if (status === "FAILURE") return { status: status, progress: "100%", reason: trimmed(body.error) || "视频生成失败，服务端未提供具体原因，请联系管理员。" };
  const url = resultURL(body);
  if (!url) return { status: "FAILURE", progress: "100%", reason: "上游报告完成，但未返回有效的视频地址。" };
  return { status: status, progress: "100%", url: url };
}

export function extractUsageOnComplete() {
  // The documented result has no actual duration/usage. Keep the frozen,
  // validated requested seconds; do not invent output duration from progress.
  return null;
}

export function listArtifacts(task) {
  return task.status === "SUCCESS" && resultURL(task.data)
    ? [{ key: "video", type: "video", mimeType: "video/mp4" }] : [];
}

export function buildContentRequest(ctx) {
  if (ctx.artifactKey !== "video") throw new Error("未找到所请求的视频资源。");
  const url = resultURL(ctx.data);
  if (!url) throw new Error("视频结果暂不可用，请稍后查询任务。");
  return { url: url, method: ctx.clientRequest.method, credentialless: true };
}

function renderOpenAIVideo(task) {
  const statuses = { NOT_START: "queued", SUBMITTED: "queued", QUEUED: "queued", IN_PROGRESS: "in_progress", SUCCESS: "completed", FAILURE: "failed" };
  const output = { id: task.task_id, object: "video", model: task.properties && task.properties.origin_model_name || "",
    status: statuses[task.status] || "unknown", progress: Number(String(task.progress || "0").replace("%", "")), created_at: task.created_at };
  if (task.status === "SUCCESS" || task.status === "FAILURE") output.completed_at = task.finish_time || task.updated_at;
  if (task.status === "FAILURE") output.error = { code: "video_task_failed", message: task.fail_reason || "视频生成失败，请联系管理员。" };
  return output;
}

export const protocols = {
  openai_video: {
    decodeRequest: function (ctx) {
      if (!ctx.body || !["json", "multipart"].includes(ctx.body.kind)) throw new Error("请使用 JSON 或 multipart 提交视频请求。");
      let request;
      if (ctx.body.kind === "json") {
        if (!ctx.body.value || typeof ctx.body.value !== "object" || Array.isArray(ctx.body.value)) throw new Error("请求内容必须为 JSON 对象。");
        request = Object.assign({}, ctx.body.value);
      } else {
        request = {};
        for (const name of Object.keys(ctx.body.fields || {})) {
          const values = ctx.body.fields[name];
          if (values.length !== 1) throw new Error("参数重复提交：" + name);
          request[name] = values[0];
        }
        for (const name of ["metadata", "images", "audios", "media", "content"]) {
          if (request[name] !== undefined) {
            try { request[name] = JSON.parse(request[name]); }
            catch (_) { throw new Error(name + " 必须为有效的 JSON。"); }
          }
        }
        for (const file of ctx.body.files || []) {
          const image = ["input_reference", "image", "images", "image[]"].includes(file.field);
          const audio = ["audio", "audios", "audio[]"].includes(file.field);
          if ((!image && !audio) || !trimmed(file.ref) ||
              !(image ? /^image\// : /^audio\//).test(file.mimeType || "")) {
            throw new Error("请上传有效的参考图片或参考音频。");
          }
          const field = image ? "images" : "audios";
          request[field] = asArray(request[field]).concat([{ __fileRef: file.ref, encoding: "dataUrl" }]);
        }
      }
      request.model = ctx.model;
      const canonical = normalizedRequest(Object.assign({}, ctx, { requestBody: request }));
      return { kind: "submit", model: ctx.model, action: canonical.images || canonical.audios ? "reference_to_video" : "text_to_video",
        requestBody: Object.assign({}, canonical, { model: ctx.model }) };
    },
    render: function (_ctx, task) { return renderOpenAIVideo(task); },
  },
};
