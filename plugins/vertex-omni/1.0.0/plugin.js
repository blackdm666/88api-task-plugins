// SPDX-License-Identifier: AGPL-3.0-or-later
// Independent adapter for the NewAPI / QuantumNous Task Plugin API v1.
// Wire references and deliberately restricted QA scope are documented in README.
const TEST_MODEL = "vertex-omni-1.1-test";
const UPSTREAM_MODEL = "gemini-omni-1.1-flash-preview";
const IMAGE_MIMES = ["image/png", "image/jpeg", "image/webp", "image/heic", "image/heif"];
const VIDEO_MIMES = ["video/mp4", "video/quicktime", "video/webm"];

export const meta = {
  apiVersion: 1,
  key: "vertex-omni",
  name: "Vertex Omni",
  icon: "VertexAI.Color",
  version: "1.0.0",
  author: { name: "88API", url: "https://github.com/blackdm666/88api-task-plugins" },
  description: {
    en: "Isolated Omni 1.1 video adapter with service-account authentication",
    zh: "使用服务账号鉴权的隔离 Omni 1.1 视频适配器",
  },
  baseUrl: "https://aiplatform.googleapis.com",
  allowedHosts: ["storage.googleapis.com"],
  // Never claim type 41, Veo, old Omni, or a production-facing model name.
  models: [TEST_MODEL],
  fetchMode: "per_task",
  auth: { type: "oauth2_jwt" },
  protocols: ["openai_video"],
  usageSchema: {
    seconds: {
      type: "number", unit: "second",
      description: { en: "Video generation unit price", zh: "视频生成单价" },
    },
    resolution: {
      enum: ["720p"],
      description: { en: "Output video resolution", zh: "输出视频分辨率" },
    },
  },
};

function text(value) { return typeof value === "string" ? value.trim() : ""; }
function object(value) { return value && typeof value === "object" && !Array.isArray(value); }
function id(value) {
  const result = text(value);
  if (!/^[A-Za-z0-9_-]{1,1024}$/.test(result)) throw new Error("Interaction 编号格式不正确，勿重复提交生成。");
  return result;
}
function number(value, label) {
  if (typeof value !== "number" && !(typeof value === "string" && /^\d+$/.test(value))) {
    throw new Error(label + "必须为整数。");
  }
  const result = Number(value);
  if (!Number.isSafeInteger(result)) throw new Error(label + "必须为整数。");
  return result;
}
function consistent(values, fallback, normalize, label) {
  let result;
  for (const value of values) {
    if (value === undefined) continue;
    const parsed = normalize(value);
    if (result !== undefined && result !== parsed) throw new Error(label + "参数冲突，请只提供一致的值。");
    result = parsed;
  }
  return result === undefined ? fallback : result;
}
function sizeAspect(value) {
  if (value === "1280x720") return "16:9";
  if (value === "720x1280") return "9:16";
  throw new Error("隔离版本仅支持 1280x720 或 720x1280。");
}
function aspect(value) {
  if (value !== "16:9" && value !== "9:16") throw new Error("画面比例仅支持 16:9 或 9:16。");
  return value;
}
function gcs(value) {
  // Object names are escaped as a single JSON API path component at download.
  const match = /^gs:\/\/([a-z0-9][a-z0-9._-]{1,220}[a-z0-9])\/([^\x00-\x20\\?#]+)$/.exec(text(value));
  if (!match || match[2] === "." || match[2] === "..") throw new Error("请提供有效的 gs://bucket/object 地址。");
  return { bucket: match[1], name: match[2] };
}
function mimeFromURI(uri) {
  const extension = uri.split(".").pop().toLowerCase();
  return { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp",
    heic: "image/heic", heif: "image/heif", mp4: "video/mp4", mov: "video/quicktime", webm: "video/webm" }[extension] || "";
}
function base64(value, limit) {
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  if (value.length / 4 * 3 - padding > limit) throw new Error("素材大小超过隔离版本限制。");
  // A flat character-class avoids V8 regex stack exhaustion on large media.
  if (!value || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    throw new Error("素材必须包含有效的 Base64 数据。");
  }
  return value;
}
function media(value, type) {
  const mimes = type === "image" ? IMAGE_MIMES : VIDEO_MIMES;
  const limit = (type === "image" ? 20 : 64) * 1024 * 1024;
  if (object(value) && value.__fileRef) {
    const mime = text(value.mimeType).toLowerCase();
    if (!mimes.includes(mime) || !/^request_file:[^\x00-\x20]+$/.test(text(value.__fileRef))) {
      throw new Error("上传素材的类型或文件引用不正确。");
    }
    return { type, mime_type: mime, data: {
      __fileRef: value.__fileRef, encoding: "base64", mimeType: mime, maxBytes: limit,
    } };
  }
  const source = typeof value === "string" ? text(value) : object(value) ? text(value.uri) : "";
  if (source.startsWith("gs://")) {
    gcs(source);
    const mime = object(value) ? text(value.mime_type).toLowerCase() : mimeFromURI(source);
    if (!mimes.includes(mime)) throw new Error("Cloud Storage 素材需要有效的 MIME 类型或文件扩展名。");
    return { type, mime_type: mime, uri: source };
  }
  const match = /^data:([^;,]+);base64,([\s\S]*)$/.exec(source);
  if (match && mimes.includes(match[1].toLowerCase())) {
    return { type, mime_type: match[1].toLowerCase(), data: base64(match[2], limit) };
  }
  if (/^https?:\/\//i.test(source)) {
    throw new Error("隔离版本不下载 HTTP(S) 输入素材，请改用 Data URI、multipart 文件或 gs:// 地址。");
  }
  throw new Error("素材格式不正确，请使用受支持 MIME 类型的 Data URI、multipart 文件或 gs:// 地址。");
}
function references(req, singular, plural, extra) {
  if (req[plural] !== undefined && !Array.isArray(req[plural])) throw new Error(plural + "必须为数组。");
  const result = (req[plural] || []).slice();
  if (req[singular] !== undefined) result.unshift(req[singular]);
  if (extra !== undefined) result.push(extra);
  return result;
}
function normalize(req, model) {
  if (!object(req)) throw new Error("请求体必须为 JSON 对象。");
  if (model !== TEST_MODEL || (req.model !== undefined && req.model !== model)) {
    throw new Error("此版本仅接受独立测试模型 " + TEST_MODEL + "。");
  }
  if (req.metadata !== undefined && !object(req.metadata)) throw new Error("metadata 必须为对象。");
  const metadata = req.metadata || {};
  const prompt = text(req.prompt);
  if (!prompt) throw new Error("请输入视频提示词。");
  const seconds = consistent([req.duration, req.seconds, metadata.duration_seconds, metadata.durationSeconds],
    3, value => number(value, "视频时长"), "视频时长");
  if (seconds < 3 || seconds > 10) throw new Error("视频时长必须为 3 到 10 秒之间的整数。");
  const ratio = consistent([req.aspect_ratio, metadata.aspect_ratio, metadata.aspectRatio,
    req.size === undefined ? undefined : sizeAspect(req.size)], "16:9", aspect, "画面比例");
  if ((req.resolution !== undefined && req.resolution !== "720p") ||
      (metadata.resolution !== undefined && metadata.resolution !== "720p")) {
    throw new Error("隔离版本仅支持 720p。");
  }
  for (const count of [req.n, req.sample_count, metadata.sampleCount, metadata.candidate_count]) {
    if (count !== undefined && number(count, "视频数量") !== 1) throw new Error("隔离版本仅支持单个视频结果。");
  }
  // No arbitrary generation_config/response_format passthrough: usage must
  // describe exactly the single, bounded request that reaches the provider.
  for (const key of ["response_format", "generation_config", "background", "store", "stream"]) {
    if (req[key] !== undefined) throw new Error(key + "由插件管理，不接受客户端覆盖。");
  }
  const images = references(req, "image", "images", req.input_reference);
  const videos = references(req, "video", "videos");
  if (images.length > 10 || videos.length > 1) throw new Error("隔离版本最多接受 10 张参考图和 1 个参考视频。");
  const content = videos.map(value => media(value, "video")).concat(images.map(value => media(value, "image")));
  content.push({ type: "text", text: prompt });
  const previous = metadata.previous_interaction_id;
  const output = metadata.output_gcs_uri;
  if (previous !== undefined) id(previous);
  if (output !== undefined) gcs(output);
  return { model, prompt, duration: seconds, aspect_ratio: ratio, resolution: "720p", content,
    previous_interaction_id: previous, output_gcs_uri: output,
    action: videos.length ? "video_to_video" : images.length ? "image_to_video" : "text_to_video" };
}
function connection(ctx) {
  if (ctx.authError || (ctx.upstream && ctx.upstream.kind === "new_api")) {
    throw new Error("此插件需要直接连接 Vertex 的服务账号鉴权渠道。");
  }
  const project = text((ctx.auth || {}).projectId);
  const authorization = text(ctx.authHeader);
  if (!/^[A-Za-z0-9][A-Za-z0-9.-]{0,127}$/.test(project) || !/^Bearer [^\s]+$/.test(authorization)) {
    throw new Error("服务账号鉴权或项目编号不可用，请检查渠道配置。");
  }
  let root = text(ctx.baseUrl) || meta.baseUrl;
  root = root.replace(/\/+$/, "").replace(/\/(?:v1|v1beta1)$/, "");
  if (!/^https?:\/\/[A-Za-z0-9.[\]:-]+$/.test(root)) throw new Error("渠道 Base URL 必须是无凭据、无查询参数的服务根地址。");
  return {
    url: root + "/v1beta1/projects/" + project + "/locations/global/interactions",
    headers: { Authorization: authorization, "Content-Type": "application/json", Accept: "application/json",
      "x-goog-user-project": project },
  };
}
export function buildSubmitRequest(ctx) {
  const model = text(ctx.upstreamModel) || UPSTREAM_MODEL;
  if (model !== TEST_MODEL && model !== UPSTREAM_MODEL) throw new Error("测试渠道只能映射到 Omni 1.1 的精确上游型号。");
  // Revalidate original inputs rather than trusting a supplied normalized object.
  const req = normalize(ctx.requestBody, ctx.model);
  const format = { type: "video", aspect_ratio: req.aspect_ratio, resolution: req.resolution,
    duration: String(req.duration) };
  if (req.output_gcs_uri) Object.assign(format, { delivery: "uri", gcs_uri: req.output_gcs_uri });
  const body = {
    model: UPSTREAM_MODEL,
    input: [{ type: "user_input", content: req.content }],
    response_format: [format],
    // Keep submit small: the host's JSON submit reader is limited to 1 MiB.
    // Large inline video results are read on polling and archived by the host.
    background: true, store: true, stream: false,
  };
  if (req.previous_interaction_id) body.previous_interaction_id = req.previous_interaction_id;
  const conn = connection(ctx);
  return { url: conn.url, method: "POST", headers: conn.headers, body, action: req.action };
}
function errors(body) {
  const items = (Array.isArray(body.errors) ? body.errors : []).slice();
  if (body.error) items.unshift(body.error);
  return items.map(error => {
    if (typeof error === "string") return error;
    if (!object(error)) return "";
    const code = error.code === undefined ? text(error.status) : String(error.code);
    const message = text(error.message);
    return code ? "[" + code + "] " + message : message;
  }).filter(Boolean).join("; ");
}
function video(body) {
  for (const group of [body.steps, body.outputs]) {
    if (!Array.isArray(group)) continue;
    for (const step of group) {
      if (!object(step) || step.type === "user_input" || step.type === "thought") continue;
      const parts = step.type === "model_output" ? (Array.isArray(step.content) ? step.content : []) : [step];
      for (const part of parts) {
        if (!object(part) || (part.type !== "video" && !text(part.mime_type).startsWith("video/"))) continue;
        const mime = text(part.mime_type) || "video/mp4";
        if (!VIDEO_MIMES.includes(mime)) continue;
        if (text(part.data)) return { url: "data:" + mime + ";base64," + base64(part.data, 256 * 1024 * 1024), mime };
        const uri = text(part.uri);
        if (uri.startsWith("gs://")) {
          const ref = gcs(uri);
          return { url: "https://storage.googleapis.com/storage/v1/b/" + encodeURIComponent(ref.bucket) +
            "/o/" + encodeURIComponent(ref.name) + "?alt=media", uri, mime };
        }
        // External signed URLs are always fetched without Google credentials.
        if (/^https:\/\/[^/@\s\\?#]+(?:\/[^\s\\]*)?$/.test(uri)) return { url: uri, uri, mime };
      }
    }
  }
  return null;
}
export function parseTaskResult(ctx, body) {
  if (!object(body)) return { status: "UNKNOWN", reason: "无法识别 Interaction 响应。" };
  if (body.id !== undefined && ctx.taskId && body.id !== ctx.taskId) {
    return { status: "UNKNOWN", reason: "Interaction 编号与已提交任务不一致。" };
  }
  const reason = errors(body);
  if (reason) return { status: "FAILURE", progress: "100%", reason };
  const status = text(body.status);
  if (status === "queued") return { status: "QUEUED", progress: "0%" };
  if (status === "in_progress") return { status: "IN_PROGRESS", progress: "50%" };
  if (["failed", "cancelled", "incomplete", "budget_exceeded", "requires_action"].includes(status)) {
    return { status: "FAILURE", progress: "100%", reason: "Interaction 已结束：" + status };
  }
  if (status !== "completed") return { status: "UNKNOWN", reason: "无法识别 Interaction 状态：" + status };
  const result = video(body);
  if (!result) return { status: "FAILURE", progress: "100%", reason: "Interaction 已完成但未返回可读取的视频。" };
  return { status: "SUCCESS", progress: "100%", url: result.url, remoteUrl: result.url };
}
export function parseSubmitResponse(ctx, response) {
  const body = response.body;
  if (!object(body)) throw new Error("视频服务未返回有效 JSON，请核查是否已受理，勿重复提交。");
  const reason = errors(body);
  if (reason) throw new Error(reason);
  if (response.statusCode >= 400) throw new Error("视频服务返回 HTTP " + response.statusCode + "，请核查是否已受理，勿重复提交。");
  const taskId = id(body.id);
  const req = normalize(ctx.requestBody, ctx.model);
  const parsed = parseTaskResult({ taskId }, body);
  if (parsed.status === "UNKNOWN") throw new Error(parsed.reason + " 请核查已受理任务，勿重复提交。");
  // Persist a compact projection only, never echoed inputs, thoughts or bytes.
  const taskData = { id: taskId, status: body.status };
  const result = video(body);
  if (parsed.status === "SUCCESS" && result && result.uri) taskData.outputs = [
    { type: "video", mime_type: result.mime, uri: result.uri },
  ];
  const output = { taskId, taskData, state: {
    seconds: req.duration, resolution: req.resolution, aspect_ratio: req.aspect_ratio,
  } };
  if (parsed.status === "SUCCESS" || parsed.status === "FAILURE") output.immediate = parsed;
  return output;
}
export function buildQueryRequest(ctx) {
  const conn = connection(ctx);
  return { url: conn.url + "/" + id(ctx.taskId), method: "GET", headers: conn.headers };
}
export function extractUsage(ctx) {
  const req = normalize(ctx.requestBody, ctx.model);
  return { seconds: req.duration, resolution: req.resolution };
}
export function extractUsageOnComplete() {
  // No verified output-duration field: retain the frozen requested seconds.
  // Do not convert token counts, progress, or thought text into billed seconds.
  return null;
}
export function listArtifacts(ctx) {
  const result = object(ctx.data) ? video(ctx.data) : null;
  return ctx.status === "SUCCESS" && result && result.uri
    ? [{ key: "video", type: "video", mimeType: result.mime }] : [];
}
export function buildContentRequest(ctx) {
  const result = object(ctx.data) ? video(ctx.data) : null;
  if (ctx.artifactKey !== "video" || !result || !result.uri) throw new Error("视频素材不可用。");
  const method = text((ctx.clientRequest || {}).method) === "HEAD" ? "HEAD" : "GET";
  if (!result.uri.startsWith("gs://")) return { url: result.url, method, credentialless: true };
  const conn = connection(ctx);
  return { url: result.url, method, headers: { Authorization: conn.headers.Authorization }, credentialless: false };
}
export const protocols = {
  openai_video: {
    decodeRequest(ctx) {
      const body = ctx.body || {};
      let req;
      if (body.kind === "json") {
        if (!object(body.value)) throw new Error("请求体必须为 JSON 对象。");
        req = Object.assign({}, body.value);
      } else if (body.kind === "multipart") {
        req = {};
        for (const key of Object.keys(body.fields || {})) {
          const values = body.fields[key];
          if (!Array.isArray(values) || values.length !== 1) throw new Error("multipart 标量字段不可重复。");
          req[key] = values[0];
        }
        for (const key of ["metadata", "images", "videos"]) {
          if (req[key] !== undefined) {
            try { req[key] = JSON.parse(req[key]); } catch (_) { throw new Error(key + "必须为有效 JSON。"); }
          }
        }
        for (const file of body.files || []) {
          const type = ["image", "images", "input_reference"].includes(file.field) ? "image"
            : ["video", "videos"].includes(file.field) ? "video" : "";
          if (!type) throw new Error("不支持该上传文件字段。");
          const limit = (type === "image" ? 20 : 64) * 1024 * 1024;
          if (!Number.isSafeInteger(file.size) || file.size < 1 || file.size > limit) throw new Error("上传素材大小不正确。");
          const key = type + "s";
          if (req[key] !== undefined && !Array.isArray(req[key])) throw new Error(key + "必须为数组。");
          if (!req[key]) req[key] = [];
          req[key].push({ __fileRef: file.ref, encoding: "base64", mimeType: file.mimeType, maxBytes: limit });
        }
      } else throw new Error("请使用 JSON 或 multipart/form-data 提交。");
      const normalized = normalize(req, ctx.model);
      // Preserve original references for build/usage validation. Normalized
      // content is derived afresh, so no hidden passthrough can change billing.
      return { kind: "submit", model: ctx.model, action: normalized.action, requestBody: req };
    },
    render(_ctx, task) {
      const result = {};
      if (task.status === "FAILURE") result.error = {
        code: "video_generation_failed", message: task.fail_reason || "视频生成失败。",
      };
      // Public lifecycle, model and download/cache URLs are host-owned.
      return result;
    },
  },
};
