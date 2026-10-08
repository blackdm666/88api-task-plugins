// SPDX-License-Identifier: AGPL-3.0-or-later
// Independent adapter for the NewAPI / QuantumNous Task Plugin API v1.
// Wire references and deliberately restricted QA scope are documented in README.
const TEST_MODEL = "vertex-omni-1.1-test";
const UPSTREAM_MODEL = "gemini-omni-1.1-flash-preview";
const IMAGE_MIMES = ["image/png", "image/jpeg", "image/webp", "image/heic", "image/heif"];
const VIDEO_MIMES = ["video/mp4", "video/quicktime", "video/webm"];
const RESOLUTIONS = ["360p", "720p", "1080p", "4k"];
const TASKS = ["text_to_video", "image_to_video", "reference_to_video", "edit", "extend"];

export const meta = {
  apiVersion: 1,
  key: "vertex-omni",
  name: "Vertex Omni",
  icon: "VertexAI.Color",
  version: "1.1.0",
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
      enum: RESOLUTIONS,
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
function sizeInfo(value) {
  const sizes = {
    "640x360": ["360p", "16:9"], "360x640": ["360p", "9:16"],
    "1280x720": ["720p", "16:9"], "720x1280": ["720p", "9:16"],
    "1920x1080": ["1080p", "16:9"], "1080x1920": ["1080p", "9:16"],
    "3840x2160": ["4k", "16:9"], "2160x3840": ["4k", "9:16"],
  };
  if (!Object.prototype.hasOwnProperty.call(sizes, value)) throw new Error("size 必须为 360p、720p、1080p 或 4k 的横屏/竖屏尺寸。");
  return sizes[value];
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
// Read only ISO-BMFF box headers and metadata, not decoded frames or mdat.
// Random-access Base64 reads avoid allocating a second full video in Sobek.
// Bill the full playable movie timeline (mvhd), not just one track's mdhd:
// verified extend output can have a 6s video track in a 9.024s movie.
function mp4Facts(data) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const length = data.length / 4 * 3 - (data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0);
  let count = 0;
  function byte(offset) {
    if (!Number.isSafeInteger(offset) || offset < 0 || offset >= length) throw new Error("MP4 越界。");
    const group = Math.floor(offset / 3) * 4;
    const index = offset % 3;
    const a = alphabet.indexOf(data.charAt(group + index));
    const b = alphabet.indexOf(data.charAt(group + index + 1));
    if (a < 0 || b < 0) throw new Error("MP4 Base64 无效。");
    return index === 0 ? (a << 2) | (b >> 4)
      : index === 1 ? ((a & 15) << 4) | (b >> 2) : ((a & 3) << 6) | b;
  }
  function uint(offset, width) {
    let value = 0;
    for (let i = 0; i < width; i++) value = value * 256 + byte(offset + i);
    if (!Number.isSafeInteger(value)) throw new Error("MP4 数字越界。");
    return value;
  }
  function kind(offset) {
    return String.fromCharCode(byte(offset), byte(offset + 1), byte(offset + 2), byte(offset + 3));
  }
  function boxes(start, end) {
    const result = [];
    for (let offset = start; offset < end;) {
      if (++count > 4096 || end - offset < 8) throw new Error("MP4 结构不正确。");
      let size = uint(offset, 4), header = 8;
      const type = kind(offset + 4);
      if (size === 1) { size = uint(offset + 8, 8); header = 16; }
      if (size === 0) size = end - offset;
      if (size < header || size > end - offset) throw new Error("MP4 结构不正确。");
      result.push({ type, start: offset + header, end: offset + size });
      offset += size;
    }
    return result;
  }
  try {
    if (!Number.isSafeInteger(length) || length < 24 || kind(4) !== "ftyp") return null;
    const moov = boxes(0, length).find(box => box.type === "moov");
    if (!moov) return null;
    const movieChildren = boxes(moov.start, moov.end);
    const mvhd = movieChildren.find(box => box.type === "mvhd");
    if (!mvhd) return null;
    const movieVersion = byte(mvhd.start);
    if (movieVersion !== 0 && movieVersion !== 1) return null;
    const movieTime = mvhd.start + (movieVersion === 0 ? 12 : 20);
    if (movieTime + (movieVersion === 0 ? 8 : 12) > mvhd.end) return null;
    const movieScale = uint(movieTime, 4);
    const movieSeconds = uint(movieTime + 4, movieVersion === 0 ? 4 : 8) / movieScale;
    if (!Number.isFinite(movieSeconds) || movieSeconds <= 0 || movieSeconds > 40.1) return null;
    const videoTracks = [];
    for (const trak of movieChildren.filter(box => box.type === "trak")) {
      const children = boxes(trak.start, trak.end);
      const mdia = children.find(box => box.type === "mdia");
      if (!mdia) continue;
      const mediaBoxes = boxes(mdia.start, mdia.end);
      const hdlr = mediaBoxes.find(box => box.type === "hdlr");
      if (!hdlr || hdlr.end - hdlr.start < 12 || kind(hdlr.start + 8) !== "vide") continue;
      const mdhd = mediaBoxes.find(box => box.type === "mdhd");
      const tkhd = children.find(box => box.type === "tkhd");
      if (!mdhd || !tkhd || tkhd.end - tkhd.start < 8) return null;
      const version = byte(mdhd.start);
      if (version !== 0 && version !== 1) return null;
      const timeOffset = mdhd.start + (version === 0 ? 12 : 20);
      if (timeOffset + (version === 0 ? 8 : 12) > mdhd.end) return null;
      const scale = uint(timeOffset, 4);
      const ticks = uint(timeOffset + 4, version === 0 ? 4 : 8);
      const seconds = ticks / scale;
      const width = uint(tkhd.end - 8, 4) / 65536;
      const height = uint(tkhd.end - 4, 4) / 65536;
      const resolution = { 360: "360p", 720: "720p", 1080: "1080p", 2160: "4k" }[Math.min(width, height)];
      if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 40.1 || !resolution) return null;
      videoTracks.push({ seconds: Math.round(movieSeconds * 1000) / 1000, resolution, width, height });
    }
    return videoTracks.length === 1 ? videoTracks[0] : null;
  } catch (_) { return null; }
}
function media(value, type) {
  const mimes = type === "image" ? IMAGE_MIMES : VIDEO_MIMES;
  const limit = (type === "image" ? 20 : 64) * 1024 * 1024;
  if (object(value) && value.__fileRef) {
    const mime = text(value.mimeType).toLowerCase();
    if (!mimes.includes(mime) || !/^request_file:[^\x00-\x20]+$/.test(text(value.__fileRef))) {
      throw new Error("上传素材的类型或文件引用不正确。");
    }
    const result = { type, mime_type: mime, data: {
      __fileRef: value.__fileRef, encoding: "base64", mimeType: mime, maxBytes: limit,
    } };
    return result;
  }
  const source = typeof value === "string" ? text(value) : object(value) ? text(value.uri) : "";
  if (source.startsWith("gs://")) {
    gcs(source);
    const mime = object(value) ? text(value.mime_type).toLowerCase() : mimeFromURI(source);
    if (!mimes.includes(mime)) throw new Error("Cloud Storage 素材需要有效的 MIME 类型或文件扩展名。");
    const result = { type, mime_type: mime, uri: source };
    return result;
  }
  const match = /^data:([^;,]+);base64,([\s\S]*)$/.exec(source);
  if (match && mimes.includes(match[1].toLowerCase())) {
    const result = { type, mime_type: match[1].toLowerCase(), data: base64(match[2], limit) };
    return result;
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
function optionalDecimal(values, fallback, label) {
  let result;
  for (const value of values) {
    if (value === undefined) continue;
    const parsed = typeof value === "number" ? value
      : typeof value === "string" && /^\d+(?:\.\d+)?$/.test(value) ? Number(value) : NaN;
    if (!Number.isFinite(parsed)) throw new Error(label + "必须为数字。");
    if (result !== undefined && result !== parsed) throw new Error(label + "参数冲突，请只提供一致的值。");
    result = parsed;
  }
  return result === undefined ? fallback : result;
}
function field(values, fallback, normalizeValue, label) {
  return consistent(values, fallback, value => normalizeValue(value, label), label);
}
function task(value) {
  const result = text(value);
  if (!TASKS.includes(result)) throw new Error("task 只支持 text_to_video、image_to_video、reference_to_video、edit 或 extend。");
  return result;
}
function mediaAlias(values, label) {
  let result;
  for (const value of values) {
    if (value === undefined) continue;
    if (result !== undefined && JSON.stringify(result) !== JSON.stringify(value)) {
      throw new Error(label + "参数冲突，请只提供一致的值。");
    }
    result = value;
  }
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
  const requestedTask = field([req.task, req.task_type, metadata.task, metadata.task_type],
    undefined, task, "task");
  const seconds = consistent([req.duration, req.seconds, metadata.duration_seconds, metadata.durationSeconds],
    requestedTask === "extend" ? 40 : 3, value => number(value, "视频时长"), "视频时长");
  const firstFrame = mediaAlias([req.first_frame, req.firstFrame, metadata.first_frame, metadata.firstFrame], "首帧");
  const lastFrame = mediaAlias([req.last_frame, req.lastFrame, metadata.last_frame, metadata.lastFrame], "尾帧");
  const images = references(req, "image", "images", req.input_reference);
  if (lastFrame !== undefined && firstFrame === undefined) throw new Error("尾帧需要同时提供首帧。");
  if ((firstFrame !== undefined || lastFrame !== undefined) && images.length) throw new Error("首尾帧字段不能与普通参考图片混用。");
  if (firstFrame !== undefined) images.push(firstFrame);
  if (lastFrame !== undefined) images.push(lastFrame);
  const videos = references(req, "video", "videos");
  const inputSeconds = optionalDecimal([
    req.input_duration, req.inputDuration, req.source_duration, req.sourceDuration,
    metadata.input_duration, metadata.inputDuration, metadata.video_duration, metadata.videoDuration,
  ], undefined, "输入视频时长");
  if (inputSeconds !== undefined && (inputSeconds < 1 || inputSeconds > 30)) {
    throw new Error("输入视频时长必须在 1 到 30 秒之间。");
  }
  const inferredTask = requestedTask || (videos.length
    ? (videos.length > 1 || images.length ? "reference_to_video" : "edit")
    : (firstFrame !== undefined || lastFrame !== undefined ? "image_to_video"
      : images.length ? "reference_to_video" : "text_to_video"));
  if (inferredTask === "extend") {
    if (seconds < 3 || seconds > 40) throw new Error("延长视频的总时长必须为 3 到 40 秒之间的整数。");
    if (videos.length !== 1) throw new Error("延长视频必须提供且只能提供 1 个参考视频。");
    if (inputSeconds !== undefined && seconds <= inputSeconds) {
      throw new Error("延长视频的总时长必须大于输入视频时长。");
    }
  } else {
    if (seconds < 3 || seconds > 10) throw new Error("视频时长必须为 3 到 10 秒之间的整数。");
  }
  if (inferredTask === "edit" && videos.length !== 1) throw new Error("视频编辑必须提供且只能提供 1 个参考视频。");
  if (inferredTask === "image_to_video" && (images.length < 1 || images.length > 2)) {
    throw new Error("首尾帧生成必须提供 1 或 2 张图片。");
  }
  if (inferredTask === "reference_to_video" && images.length === 0 && videos.length === 0) {
    throw new Error("参考生成至少需要 1 个参考图片或视频。");
  }
  if (inferredTask === "text_to_video" && (images.length || videos.length)) throw new Error("文字生成不能同时提供参考素材。");
  if (inferredTask === "image_to_video" && videos.length) throw new Error("首尾帧生成不能提供参考视频。");
  if (firstFrame !== undefined && inferredTask !== "image_to_video") throw new Error("首尾帧字段仅适用于 image_to_video。");
  const size = req.size === undefined ? undefined : sizeInfo(req.size);
  const ratio = consistent([req.aspect_ratio, req.ratio, metadata.aspect_ratio, metadata.aspectRatio,
    size && size[1]], "16:9", aspect, "画面比例");
  const resolution = field([req.resolution, metadata.resolution, req.output, metadata.output, size && size[0]],
    "720p", value => {
      const result = text(value);
      if (!RESOLUTIONS.includes(result)) throw new Error("输出分辨率仅支持 360p、720p、1080p 或 4k。");
      return result;
    }, "输出分辨率");
  const explicitResolution = [req.resolution, metadata.resolution, req.output, metadata.output, req.size].some(v => v !== undefined);
  if (["edit", "extend"].includes(inferredTask) &&
      [req.aspect_ratio, req.ratio, metadata.aspect_ratio, metadata.aspectRatio, req.size].some(v => v !== undefined)) {
    throw new Error("视频编辑或延长沿用输入画面比例，请移除 aspect_ratio、ratio 和 size。");
  }
  if (inferredTask === "extend" && explicitResolution) {
    throw new Error("延长视频沿用输入分辨率，请移除 resolution 或 output。");
  }
  for (const count of [req.n, req.sample_count, metadata.sampleCount, metadata.candidate_count]) {
    if (count !== undefined && number(count, "视频数量") !== 1) throw new Error("隔离版本仅支持单个视频结果。");
  }
  // No arbitrary generation_config/response_format passthrough: usage must
  // describe exactly the single, bounded request that reaches the provider.
  for (const key of ["response_format", "generation_config", "background", "store", "stream"]) {
    if (req[key] !== undefined) throw new Error(key + "由插件管理，不接受客户端覆盖。");
  }
  if (req.audio !== undefined || req.audios !== undefined || metadata.audio !== undefined || metadata.audios !== undefined) {
    throw new Error("Omni 1.1 不支持独立音频输入。");
  }
  const temperature = optionalDecimal([req.temperature, metadata.temperature], undefined, "temperature");
  const topP = optionalDecimal([req.top_p, req.topP, metadata.top_p, metadata.topP], undefined, "top_p");
  if (temperature !== undefined && (temperature < 0 || temperature > 2)) throw new Error("temperature 必须在 0 到 2 之间。");
  if (topP !== undefined && (topP < 0 || topP > 1)) throw new Error("top_p 必须在 0 到 1 之间。");
  if (images.length > 10 || videos.length > 3) throw new Error("隔离版本最多接受 10 张参考图和 3 个参考视频。");
  if (["edit", "extend"].includes(inferredTask) && images.length > 0) {
    throw new Error("视频编辑或延长不能同时提供参考图片。");
  }
  const content = videos.map(value => media(value, "video")).concat(images.map(value => media(value, "image")));
  let measuredInput;
  if (inferredTask === "extend" && typeof content[0].data === "string") {
    measuredInput = mp4Facts(content[0].data);
    if (!measuredInput) throw new Error("延长输入必须是可测量时长的非分片 MP4。");
    if (measuredInput.seconds < 1 || measuredInput.seconds > 30.1) throw new Error("延长输入视频时长必须在 1 到 30 秒之间。");
    if (inputSeconds !== undefined && Math.abs(inputSeconds - measuredInput.seconds) > 0.1) throw new Error("输入视频时长与 MP4 不一致。");
  }
  const framePrompt = firstFrame !== undefined
    ? (lastFrame !== undefined ? " Use the first image as the first frame and the second image as the last frame."
      : " Use the image as the first frame.") : "";
  content.push({ type: "text", text: prompt + framePrompt });
  const previous = field([req.previous_interaction_id, metadata.previous_interaction_id], undefined, id, "Interaction 编号");
  const output = metadata.output_gcs_uri;
  if (previous !== undefined) id(previous);
  if (output !== undefined) gcs(output);
  if (inferredTask === "extend" && output !== undefined) {
    throw new Error("延长任务需返回内联 MP4 用于完整时长结算，请移除 output_gcs_uri。");
  }
  return { model, prompt, duration: seconds, input_duration: measuredInput ? measuredInput.seconds : inputSeconds, task: inferredTask,
    aspect_ratio: ratio, resolution, explicit_resolution: explicitResolution, temperature, top_p: topP, content,
    previous_interaction_id: previous, output_gcs_uri: output,
    action: inferredTask };
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
  const format = { type: "video" };
  // Google REST response_format duration includes its seconds unit ("3s").
  // Keep ordinary generation's request billing numeric and unchanged.
  if (!["edit", "extend"].includes(req.task)) format.duration = String(req.duration) + "s";
  // Google rejects aspect_ratio on edit/extend. For those tasks the source
  // video determines the framing. Extension duration is not a verified
  // final-duration control: reserve an estimate, then measure the output.
  if (!["edit", "extend"].includes(req.task)) {
    Object.assign(format, { aspect_ratio: req.aspect_ratio, resolution: req.resolution });
  }
  if (req.task === "edit" && req.explicit_resolution) format.output = req.resolution;
  if (req.output_gcs_uri) Object.assign(format, { delivery: "uri", gcs_uri: req.output_gcs_uri });
  const body = {
    model: UPSTREAM_MODEL,
    input: [{ type: "user_input", content: req.content }],
    response_format: [format],
    // Keep submit small: the host's JSON submit reader is limited to 1 MiB.
    // Large inline video results are read on polling and archived by the host.
    background: true, store: true, stream: false,
    generation_config: {
      video_config: { task: req.task },
    },
  };
  if (req.temperature !== undefined) body.generation_config.temperature = req.temperature;
  if (req.top_p !== undefined) body.generation_config.top_p = req.top_p;
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
        if (text(part.data)) return { url: "data:" + mime + ";base64," + base64(part.data, 256 * 1024 * 1024), mime, data: part.data };
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
  if (ctx.action === "extend" || (ctx.state || {}).task === "extend") {
    const facts = result.data && mp4Facts(result.data);
    if (!facts) return { status: "UNKNOWN", reason: "延长成品的完整 MP4 时长无法核验，不能按预估时长完成结算。" };
    return { status: "SUCCESS", progress: "100%", url: result.url, remoteUrl: result.url,
      state: Object.assign({}, ctx.state || {}, { task: "extend", output_seconds: facts.seconds, output_resolution: facts.resolution }) };
  }
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
  const parsed = parseTaskResult({ taskId, action: req.task }, body);
  if (parsed.status === "UNKNOWN") throw new Error(parsed.reason + " 请核查已受理任务，勿重复提交。");
  // Persist a compact projection only, never echoed inputs, thoughts or bytes.
  const taskData = { id: taskId, status: body.status };
  const result = video(body);
  if (parsed.status === "SUCCESS" && result && result.uri) taskData.outputs = [
    { type: "video", mime_type: result.mime, uri: result.uri },
  ];
  const state = { seconds: req.duration, resolution: req.resolution, aspect_ratio: req.aspect_ratio };
  if (req.input_duration !== undefined) state.input_seconds = req.input_duration;
  if (req.task !== "text_to_video") state.task = req.task;
  if (parsed.state) Object.assign(state, parsed.state);
  const output = { taskId, taskData, state };
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
export function extractUsageOnComplete(ctx, result, data) {
  if (ctx.action !== "extend" && (ctx.state || {}).task !== "extend") return null;
  if (result.status !== "SUCCESS") return null;
  const output = object(data) ? video(data) : null;
  const facts = output && output.data ? mp4Facts(output.data) : null;
  // Immediate completion stores a measured projection after the byte body is
  // deliberately omitted from taskData. This state is plugin-owned, not a
  // client hint or a token-to-duration conversion.
  const state = ctx.state || {};
  if (facts) return { seconds: facts.seconds, resolution: facts.resolution };
  if (Number.isFinite(state.output_seconds) && state.output_seconds > 0 && state.output_seconds <= 40.1 &&
      RESOLUTIONS.includes(state.output_resolution)) {
    return { seconds: state.output_seconds, resolution: state.output_resolution };
  }
  throw new Error("延长成品完整时长尚未核验。");
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
          const frame = ["first_frame", "firstFrame", "last_frame", "lastFrame"].includes(file.field);
          const type = frame || ["image", "images", "input_reference"].includes(file.field) ? "image"
            : ["video", "videos"].includes(file.field) ? "video" : "";
          if (!type) throw new Error("不支持该上传文件字段。");
          const limit = (type === "image" ? 20 : 64) * 1024 * 1024;
          if (!Number.isSafeInteger(file.size) || file.size < 1 || file.size > limit) throw new Error("上传素材大小不正确。");
          const reference = { __fileRef: file.ref, encoding: "base64", mimeType: file.mimeType, maxBytes: limit };
          if (frame) {
            if (req[file.field] !== undefined) throw new Error("首尾帧文件字段不可重复。");
            req[file.field] = reference;
            continue;
          }
          const key = type + "s";
          if (req[key] !== undefined && !Array.isArray(req[key])) throw new Error(key + "必须为数组。");
          if (!req[key]) req[key] = [];
          req[key].push(reference);
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
