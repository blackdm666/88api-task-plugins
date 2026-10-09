// SPDX-License-Identifier: AGPL-3.0-or-later
// Independent adapter for the NewAPI / QuantumNous Task Plugin API v1.
// Wire references and deliberately restricted QA scope are documented in README.
const IMAGE_MIMES = ["image/png", "image/jpeg", "image/webp", "image/heic", "image/heif"];
const VIDEO_MIMES = ["video/mp4", "video/quicktime", "video/webm"];
// Measurable output resolutions. 360p is not sold: requests are upgraded and
// billed at 720p, so it never appears as a billing fact.
const RESOLUTIONS = ["360p", "720p", "1080p", "4k"];
const BILLED_RESOLUTIONS = ["720p", "1080p", "4k"];
function billed(resolution) { return resolution === "360p" ? "720p" : resolution; }
// Verified 2026-10-09: extension rejects 4k after minutes of upstream work.
const EXTEND_RESOLUTIONS = ["720p", "1080p"];
const TASKS = ["text_to_video", "image_to_video", "reference_to_video", "edit", "extend"];
// Veo 3.1 / Fast (GA, verified 2026-10-09): 4/6/8s, 720p/1080p/4k on both,
// JPEG/PNG images, references need 8s, an extension adds a fixed 7s.
const VEO_RESOLUTIONS = ["720p", "1080p", "4k"];
const VEO_DURATIONS = [4, 6, 8];
const VEO_TASKS = ["text_to_video", "image_to_video", "reference_to_video", "extend"];
const VEO_IMAGE_MIMES = ["image/jpeg", "image/png"];
const VEO_REGION = "us-central1";
const VEO_EXTEND_RESERVE_SECONDS = 8;
// Public names are production since 1.5.0: declaring them pins all of their
// traffic to channels bound to this plugin (type-41 channels no longer serve
// them). The isolated test names stay available for QA channels.
const MODELS = {
  "vertex-omni-1.1-test": { family: "omni", upstream: "gemini-omni-1.1-flash-preview", label: "Omni 1.1",
    resolutions: BILLED_RESOLUTIONS, upgrade360: true, tasks: TASKS, continuation: true },
  // Old Omni Flash: only 720p is accepted; extension fails upstream.
  "vertex-omni-flash-test": { family: "omni", upstream: "gemini-omni-flash-preview", label: "Omni Flash",
    resolutions: ["720p"], upgrade360: true, tasks: ["text_to_video", "image_to_video", "reference_to_video"], continuation: false },
  "vertex-veo-3.1-test": { family: "veo", upstream: "veo-3.1-generate-001", label: "Veo 3.1" },
  "vertex-veo-3.1-fast-test": { family: "veo", upstream: "veo-3.1-fast-generate-001", label: "Veo 3.1 Fast" },
};
Object.assign(MODELS, {
  "veo-3.1": MODELS["vertex-veo-3.1-test"],
  "veo-3.1-fast": MODELS["vertex-veo-3.1-fast-test"],
  "gemini-omni-flash": MODELS["vertex-omni-flash-test"],
  "gemini-omni-flash-1.1": MODELS["vertex-omni-1.1-test"],
});
function spec(model) {
  if (typeof model !== "string" || !Object.prototype.hasOwnProperty.call(MODELS, model)) {
    throw new Error("此版本仅接受独立测试模型 " + Object.keys(MODELS).join("、") + "。");
  }
  return MODELS[model];
}
// Inputs and results live in one central media bucket, never inline Base64:
// Google accepts only gs:// input URIs ("Only GCS URIs are supported").
// Each channel project's Vertex service agent and service account are granted
// objectCreator+objectViewer on it (Google reads/writes as the service agent).
const MEDIA_BUCKET = "88api-omni-media";
// The transfer Worker copies HTTP(S) inputs into the bucket (preflight) and
// reads only MP4 headers of stored results (probe).
const WORKER_HOST = "assets.88api.ai";
const INGEST_URL = "https://" + WORKER_HOST + "/gcs/ingest";
const PROBE_URL = "https://" + WORKER_HOST + "/gcs/probe";
// One extension adds ~10s (10.005–10.032s verified); reserve, then settle.
const EXTEND_RESERVE_SECONDS = 11;
const EXTEND_MAX_INPUT_SECONDS = 30.1;

export const meta = {
  apiVersion: 1,
  key: "vertex-omni",
  name: "Vertex Video",
  icon: "VertexAI.Color",
  version: "1.5.0",
  // HTTP(S) inputs are copied to GCS before submit; requires host preflight.
  requiredCapabilities: ["task-preflight@1"],
  author: { name: "88API", url: "https://github.com/blackdm666/88api-task-plugins" },
  description: {
    en: "Vertex Omni 1.1 / Omni Flash / Veo 3.1 / Veo 3.1 Fast video adapter with service-account authentication and GCS delivery",
    zh: "使用服务账号鉴权、GCS 交付的 Vertex 视频适配器（Omni 1.1、Omni Flash、Veo 3.1、Veo 3.1 Fast）",
  },
  baseUrl: "https://aiplatform.googleapis.com",
  allowedHosts: ["storage.googleapis.com", VEO_REGION + "-aiplatform.googleapis.com", WORKER_HOST],
  // Never claim type 41; public names route only to channels bound here.
  models: Object.keys(MODELS),
  fetchMode: "per_task",
  auth: { type: "oauth2_jwt" },
  protocols: ["openai_video"],
  usageSchema: {
    seconds: {
      type: "number", unit: "second",
      description: { en: "Video generation unit price", zh: "视频生成单价" },
    },
    resolution: {
      enum: BILLED_RESOLUTIONS,
      description: { en: "Output video resolution", zh: "输出视频分辨率" },
    },
    // Veo only: Google prices video with and without generated audio differently.
    generate_audio: {
      type: "boolean",
      description: { en: "Whether audio is generated (Veo)", zh: "是否生成音频（Veo）" },
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
    // The verified 40s video track has a 40.363s complete movie due to its
    // generated audio tail. Bound the movie to 41s, while still bounding the
    // video track to 40s (+0.1s metadata tolerance) below.
    if (!Number.isFinite(movieSeconds) || movieSeconds <= 0 || movieSeconds > 41) return null;
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
const IMAGE_LIMIT = 20 * 1024 * 1024;
// Raw Base64 (no data: prefix) is accepted for images, as the old type-41
// adaptor did; the format is recognised from its leading bytes.
function sniffImage(value) {
  if (value.startsWith("iVBORw0KGgo")) return "image/png";
  if (value.startsWith("/9j/")) return "image/jpeg";
  if (value.startsWith("UklGR") && value.slice(8, 16).startsWith("V0VCU")) return "image/webp";
  return "";
}
// Videos are HTTP(S) URLs only: the Worker copies them into the media bucket
// during preflight and measures extension input. Images additionally accept
// Data URI, raw Base64 and multipart files, inlined to Google (<=20MiB) as
// before 1.3.0, so existing clients keep working.
function media(value, type, imageMimes) {
  const source = typeof value === "string" ? text(value) : "";
  if (source.length <= 4096 && /^https?:\/\/[^\s/@\\?#]+(?:[/?#][^\s\\]*)?$/i.test(source)) return { type, url: source };
  if (type === "image") {
    const mimes = imageMimes || IMAGE_MIMES;
    const allowed = mime => {
      if (!mimes.includes(mime)) throw new Error("图片类型 " + (mime || "未知") + " 不受支持，支持 " + mimes.join("、") + "。");
      return mime;
    };
    if (object(value) && value.__fileRef !== undefined) {
      if (!/^request_file:[^\x00-\x20]+$/.test(text(value.__fileRef))) throw new Error("上传图片的文件引用不正确。");
      const mime = allowed(text(value.mimeType).toLowerCase());
      return { type, mime_type: mime, data: { __fileRef: value.__fileRef, encoding: "base64", mimeType: mime, maxBytes: IMAGE_LIMIT } };
    }
    const match = /^data:([^;,]+);base64,([\s\S]*)$/.exec(source);
    if (match) return { type, mime_type: allowed(match[1].toLowerCase()), data: base64(match[2], IMAGE_LIMIT) };
    if (source.length >= 16 && !source.includes(":")) {
      const mime = sniffImage(source);
      if (mime) return { type, mime_type: allowed(mime), data: base64(source, IMAGE_LIMIT) };
    }
    throw new Error("图片支持 HTTP(S) 链接、Data URI（data:<MIME>;base64,...）、PNG/JPEG/WebP 的 Base64 或 multipart 文件（20MiB 内）。");
  }
  throw new Error("视频仅接受 HTTP(S) 链接，支持 MP4/MOV/WebM（64MiB 内）。");
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
  const sp = spec(model);
  if (req.model !== undefined && req.model !== model) throw new Error("请求体 model 与路由模型不一致。");
  if (sp.family === "veo") return normalizeVeo(req, model, sp);
  if (req.metadata !== undefined && !object(req.metadata)) throw new Error("metadata 必须为对象。");
  const metadata = req.metadata || {};
  const prompt = text(req.prompt);
  if (!prompt) throw new Error("请输入视频提示词。");
  const requestedTask = field([req.task, req.task_type, metadata.task, metadata.task_type],
    undefined, task, "task");
  const durations = [req.duration, req.seconds, metadata.duration_seconds, metadata.durationSeconds];
  // Google rejects an extension duration and always adds one ~10s segment.
  if (requestedTask === "extend" && durations.some(value => value !== undefined)) {
    throw new Error("延长每次由上游固定新增约 10 秒，不支持 duration/seconds，请移除。");
  }
  const seconds = requestedTask === "extend" ? EXTEND_RESERVE_SECONDS
    : consistent(durations, 3, value => number(value, "视频时长"), "视频时长");
  let firstFrame = mediaAlias([req.first_frame, req.firstFrame, metadata.first_frame, metadata.firstFrame], "首帧");
  const lastFrame = mediaAlias([req.last_frame, req.lastFrame, metadata.last_frame, metadata.lastFrame], "尾帧");
  const images = references(req, "image", "images", req.input_reference);
  if (lastFrame !== undefined && firstFrame === undefined) throw new Error("尾帧需要同时提供首帧。");
  if ((firstFrame !== undefined || lastFrame !== undefined) && images.length) throw new Error("首尾帧字段不能与普通参考图片混用。");
  const videos = references(req, "video", "videos");
  // A single image without a task is the first frame (OpenAI input_reference
  // semantics); two or more without a task remain references.
  if (requestedTask === undefined && firstFrame === undefined && images.length === 1 && !videos.length &&
      req.previous_interaction_id === undefined && metadata.previous_interaction_id === undefined) {
    firstFrame = images.pop();
  }
  if (firstFrame !== undefined) images.push(firstFrame);
  if (lastFrame !== undefined) images.push(lastFrame);
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
    if (videos.length !== 1) throw new Error("延长视频必须提供且只能提供 1 个参考视频。");
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
  if (!sp.tasks.includes(inferredTask)) throw new Error(sp.label + " 不支持 " + inferredTask + "，支持：" + sp.tasks.join("、") + "。");
  const size = req.size === undefined ? undefined : sizeInfo(req.size);
  const ratio = consistent([req.aspect_ratio, req.ratio, metadata.aspect_ratio, metadata.aspectRatio,
    size && size[1]], "16:9", aspect, "画面比例");
  const resolution = field([req.resolution, metadata.resolution, req.output, metadata.output, size && size[0]],
    "720p", value => {
      const requested = text(value);
      const result = sp.upgrade360 && requested === "360p" ? "720p" : requested;
      if (!sp.resolutions.includes(result)) throw new Error(sp.label + " 输出分辨率仅支持 " + sp.resolutions.join("、") + "。");
      return result;
    }, "输出分辨率");
  const explicitResolution = [req.resolution, metadata.resolution, req.output, metadata.output, req.size].some(v => v !== undefined);
  if (["edit", "extend"].includes(inferredTask) &&
      [req.aspect_ratio, req.ratio, metadata.aspect_ratio, metadata.aspectRatio, req.size].some(v => v !== undefined)) {
    throw new Error("视频编辑或延长沿用输入画面比例，请移除 aspect_ratio、ratio 和 size。");
  }
  // Extension does not inherit the source resolution: unset outputs 720p.
  if (inferredTask === "extend" && !EXTEND_RESOLUTIONS.includes(resolution)) {
    throw new Error("延长视频仅支持 720p 或 1080p 输出（上游不支持 4K 延长），未指定时为 720p。");
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
    throw new Error(sp.label + " 不支持独立音频输入。");
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
  const framePrompt = firstFrame !== undefined
    ? (lastFrame !== undefined ? " Use the first image as the first frame and the second image as the last frame."
      : " Use the image as the first frame.") : "";
  content.push({ type: "text", text: prompt + framePrompt });
  const previous = field([req.previous_interaction_id, metadata.previous_interaction_id], undefined, id, "Interaction 编号");
  if (previous !== undefined) id(previous);
  if (previous !== undefined && !sp.continuation) throw new Error(sp.label + " 不支持多轮续接。");
  if (previous !== undefined && (requestedTask !== undefined || firstFrame !== undefined || lastFrame !== undefined)) {
    throw new Error("多轮请求不能同时指定 task 或首尾帧模式，请沿用上一轮上下文。");
  }
  if (metadata.output_gcs_uri !== undefined) throw new Error("输出位置由插件管理，请移除 metadata.output_gcs_uri。");
  return { family: "omni", model, upstream: sp.upstream, prompt, duration: seconds, input_duration: inputSeconds,
    task: inferredTask, aspect_ratio: ratio, resolution, explicit_resolution: explicitResolution, temperature,
    top_p: topP, content, previous_interaction_id: previous, action: inferredTask };
}
// Veo uses predictLongRunning instead of Interactions. Inputs are the same
// HTTP(S) URLs (copied by preflight); roles map onto Veo instance fields.
function flag(value, label) {
  if (typeof value !== "boolean") throw new Error(label + "必须为 true 或 false。");
  return value;
}
function normalizeVeo(req, model, sp) {
  if (req.metadata !== undefined && !object(req.metadata)) throw new Error("metadata 必须为对象。");
  const metadata = req.metadata || {};
  const prompt = text(req.prompt);
  if (!prompt) throw new Error("请输入视频提示词。");
  const requestedTask = field([req.task, req.task_type, metadata.task, metadata.task_type], undefined, value => {
    const result = text(value);
    if (!VEO_TASKS.includes(result)) throw new Error(sp.label + " 的 task 只支持 " + VEO_TASKS.join("、") + "。");
    return result;
  }, "task");
  const firstFrame = mediaAlias([req.first_frame, req.firstFrame, metadata.first_frame, metadata.firstFrame], "首帧");
  const lastFrame = mediaAlias([req.last_frame, req.lastFrame, metadata.last_frame, metadata.lastFrame], "尾帧");
  const images = references(req, "image", "images", req.input_reference);
  const videos = references(req, "video", "videos");
  if (lastFrame !== undefined && firstFrame === undefined && images.length !== 1) throw new Error("尾帧需要同时提供首帧。");
  if (firstFrame !== undefined && images.length) throw new Error("首尾帧字段不能与普通参考图片混用。");
  // A single image without a task is the first frame (OpenAI input_reference
  // semantics); two or three are asset references, which Veo fixes at 8s.
  // Old type-41 clients select frames/reference with metadata.video_mode.
  const mode = metadata.video_mode;
  if (mode !== undefined && mode !== "frames" && mode !== "reference") throw new Error("metadata.video_mode 只支持 frames 或 reference。");
  const modeTask = mode === "frames" ? "image_to_video" : mode === "reference" ? "reference_to_video" : undefined;
  if (requestedTask !== undefined && modeTask !== undefined && requestedTask !== modeTask) throw new Error("task 与 metadata.video_mode 冲突。");
  // Without a task: one image is the first frame, two are first+last frames,
  // three are asset references (Veo fixes references at 8s).
  const task = requestedTask || modeTask || (videos.length ? "extend"
    : firstFrame !== undefined || lastFrame !== undefined || images.length === 1 || images.length === 2 ? "image_to_video"
      : images.length ? "reference_to_video" : "text_to_video");
  const durations = [req.duration, req.seconds, metadata.duration_seconds, metadata.durationSeconds];
  if (task === "extend" && durations.some(value => value !== undefined)) {
    throw new Error(sp.label + " 延长每次由上游固定新增 7 秒，不支持 duration/seconds，请移除。");
  }
  const seconds = task === "extend" ? VEO_EXTEND_RESERVE_SECONDS
    : consistent(durations, 8, value => number(value, "视频时长"), "视频时长");
  if (task !== "extend" && !VEO_DURATIONS.includes(seconds)) throw new Error(sp.label + " 视频时长只支持 4、6 或 8 秒。");
  if (task === "reference_to_video" && seconds !== 8) throw new Error(sp.label + " 参考图生成只支持 8 秒。");
  const content = [];
  if (task === "text_to_video") {
    if (images.length || videos.length || firstFrame !== undefined) throw new Error("文字生成不能同时提供参考素材。");
  } else if (task === "image_to_video") {
    if (videos.length) throw new Error("首尾帧生成不能提供视频。");
    const first = firstFrame !== undefined ? firstFrame : images[0];
    const last = lastFrame !== undefined ? lastFrame : images[1];
    if (first === undefined || images.length > (firstFrame !== undefined ? 0 : 2)) throw new Error("首尾帧生成必须提供 1 或 2 张图片。");
    content.push(Object.assign(media(first, "image", VEO_IMAGE_MIMES), { role: "first_frame" }));
    if (last !== undefined) content.push(Object.assign(media(last, "image", VEO_IMAGE_MIMES), { role: "last_frame" }));
  } else if (task === "reference_to_video") {
    if (videos.length || firstFrame !== undefined || lastFrame !== undefined) throw new Error("参考图生成只接受 1 到 3 张参考图片。");
    if (images.length < 1 || images.length > 3) throw new Error(sp.label + " 参考图生成需要 1 到 3 张参考图片。");
    for (const image of images) content.push(Object.assign(media(image, "image", VEO_IMAGE_MIMES), { role: "reference" }));
  } else {
    if (videos.length !== 1 || images.length || firstFrame !== undefined || lastFrame !== undefined) {
      throw new Error("延长视频必须提供且只能提供 1 个视频，不能同时提供图片。");
    }
    content.push(Object.assign(media(videos[0], "video"), { role: "video" }));
  }
  const size = req.size === undefined ? undefined : sizeInfo(req.size);
  const ratioInputs = [req.aspect_ratio, req.ratio, metadata.aspect_ratio, metadata.aspectRatio, size && size[1]];
  const resolutionInputs = [req.resolution, metadata.resolution, req.output, metadata.output, size && size[0]];
  if (task === "extend" && ratioInputs.concat(resolutionInputs).some(value => value !== undefined)) {
    throw new Error(sp.label + " 延长沿用输入视频的画面，请移除 aspect_ratio、resolution 和 size。");
  }
  const ratio = consistent(ratioInputs, "16:9", aspect, "画面比例");
  const resolution = field(resolutionInputs, "720p", value => {
    const result = text(value);
    if (!VEO_RESOLUTIONS.includes(result)) throw new Error(sp.label + " 输出分辨率仅支持 720p、1080p 或 4k。");
    return result;
  }, "输出分辨率");
  const generateAudio = consistent([req.generate_audio, req.generateAudio, metadata.generate_audio, metadata.generateAudio],
    true, value => flag(value, "generate_audio"), "generate_audio");
  const negative = consistent([req.negative_prompt, req.negativePrompt, metadata.negative_prompt, metadata.negativePrompt],
    undefined, value => {
      if (typeof value !== "string" || value.length > 2000) throw new Error("negative_prompt 必须为 2000 字以内的字符串。");
      return value.trim();
    }, "negative_prompt");
  const seed = consistent([req.seed, metadata.seed], undefined, value => {
    const result = number(value, "seed");
    if (result < 0 || result > 4294967295) throw new Error("seed 必须在 0 到 4294967295 之间。");
    return result;
  }, "seed");
  for (const count of [req.n, req.sample_count, metadata.sampleCount, metadata.candidate_count]) {
    if (count !== undefined && number(count, "视频数量") !== 1) throw new Error("隔离版本仅支持单个视频结果。");
  }
  for (const key of ["response_format", "generation_config", "background", "store", "stream", "parameters", "instances"]) {
    if (req[key] !== undefined) throw new Error(key + "由插件管理，不接受客户端覆盖。");
  }
  for (const key of ["temperature", "top_p", "topP", "previous_interaction_id"]) {
    if (req[key] !== undefined || metadata[key] !== undefined) throw new Error(sp.label + " 不支持 " + key + "。");
  }
  if (req.audio !== undefined || req.audios !== undefined || metadata.audio !== undefined || metadata.audios !== undefined) {
    throw new Error(sp.label + " 不支持独立音频输入。");
  }
  if (metadata.output_gcs_uri !== undefined) throw new Error("输出位置由插件管理，请移除 metadata.output_gcs_uri。");
  const inputSeconds = optionalDecimal([
    req.input_duration, req.inputDuration, req.source_duration, req.sourceDuration,
    metadata.input_duration, metadata.inputDuration, metadata.video_duration, metadata.videoDuration,
  ], undefined, "输入视频时长");
  if (inputSeconds !== undefined && (inputSeconds < 1 || inputSeconds > 30)) throw new Error("输入视频时长必须在 1 到 30 秒之间。");
  return { family: "veo", model, upstream: sp.upstream, prompt, duration: seconds, input_duration: inputSeconds, task,
    aspect_ratio: ratio, resolution, generate_audio: generateAudio, negative_prompt: negative || undefined, seed,
    content, image_mimes: VEO_IMAGE_MIMES, action: task };
}
// Operation names are ASCII; encode them so the host stores a safe task ID.
const B64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
function b64url(value) {
  let out = "";
  for (let i = 0; i < value.length; i += 3) {
    const a = value.charCodeAt(i), b = value.charCodeAt(i + 1), c = value.charCodeAt(i + 2);
    out += B64URL[a >> 2] + B64URL[((a & 3) << 4) | (b >> 4 || 0)];
    if (i + 1 < value.length) out += B64URL[((b & 15) << 2) | (c >> 6 || 0)];
    if (i + 2 < value.length) out += B64URL[c & 63];
  }
  return out;
}
function unb64url(value) {
  let out = "", buffer = 0, bits = 0;
  for (const char of value) {
    const index = B64URL.indexOf(char);
    if (index < 0) throw new Error("Veo 任务编号格式不正确。");
    buffer = (buffer << 6) | index; bits += 6;
    if (bits >= 8) { bits -= 8; out += String.fromCharCode((buffer >> bits) & 255); }
  }
  return out;
}
function veoOperation(name) {
  const match = /^projects\/[A-Za-z0-9][A-Za-z0-9.-]{0,127}\/locations\/us-central1\/publishers\/google\/models\/([a-z0-9.-]+)\/operations\/[A-Za-z0-9_-]{1,128}$/.exec(text(name));
  const known = Object.keys(MODELS).map(key => MODELS[key]).filter(item => item.family === "veo").map(item => item.upstream);
  if (!match || !known.includes(match[1])) throw new Error("Veo 操作编号格式不正确，勿重复提交生成。");
  return { name: text(name), upstream: match[1] };
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
  // Veo is regional; the default global host maps to its regional endpoint.
  const regional = root === meta.baseUrl ? "https://" + VEO_REGION + "-aiplatform.googleapis.com" : root;
  return {
    project,
    url: root + "/v1beta1/projects/" + project + "/locations/global/interactions",
    veo: regional + "/v1/projects/" + project + "/locations/" + VEO_REGION + "/publishers/google/models/",
    headers: { Authorization: authorization, "Content-Type": "application/json", Accept: "application/json",
      "x-goog-user-project": project },
  };
}
// The transfer Worker can read the bucket; results are then copied to R2.
function outputPrefix(publicTaskId) {
  const task = /^task_[A-Za-z0-9_-]{8,191}$/.test(text(publicTaskId)) ? text(publicTaskId) : "unassigned";
  return "gs://" + MEDIA_BUCKET + "/vertex-omni/" + task + "/";
}
export function buildPreflightRequest(ctx) {
  const req = normalize(ctx.requestBody, ctx.model);
  const items = req.content.filter(part => part.url);
  if (!items.length) return null;
  const conn = connection(ctx);
  // The channel token travels in the JSON body (not a logged header) to the
  // Worker, which uses it only against the allowlisted bucket on Google; IAM
  // write permission on that bucket is therefore the ingest authorization.
  return { url: INGEST_URL, method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: { authorization: conn.headers.Authorization, bucket: MEDIA_BUCKET,
      measure: req.task === "extend", items: items.map(part => ({ url: part.url, kind: part.type })) } };
}
// Replace URL placeholders with the preflight's gs:// copies, in order, and
// return the measured extension input. Anything inconsistent fails before
// Google is called, so nothing is billed.
function ingestedContent(ctx, req) {
  const wanted = req.content.filter(part => part.url);
  if (!wanted.length) return { content: req.content };
  const preflight = object(ctx.preflightResponse) ? ctx.preflightResponse : {};
  const body = object(preflight.body) ? preflight.body : {};
  if (body.object !== "gcs_ingest") throw new Error("素材转存服务未返回有效结果，请稍后重试。");
  if (body.error !== undefined) throw new Error("素材转存失败：" + (errors(body) || "未知错误"));
  if (!Array.isArray(body.items) || body.items.length !== wanted.length) throw new Error("素材转存结果数量不一致，请重试。");
  let index = 0, measured;
  const content = req.content.map(part => {
    if (!part.url) return part;
    const item = body.items[index++];
    const mimes = part.type === "image" ? (req.image_mimes || IMAGE_MIMES) : VIDEO_MIMES;
    if (!object(item) || item.url !== part.url || item.kind !== part.type || gcs(item.uri).bucket !== MEDIA_BUCKET) {
      throw new Error("素材转存结果与请求不一致，请重试。");
    }
    if (!mimes.includes(text(item.mime_type))) {
      throw new Error("素材类型 " + (text(item.mime_type) || "未知") + " 不受支持，" +
        (part.type === "image" ? "图片支持 " : "视频支持 ") + mimes.join("、") + "。");
    }
    if (part.type === "video" && item.facts !== undefined) measured = item.facts;
    const out = { type: part.type, mime_type: text(item.mime_type), uri: item.uri };
    if (part.role) out.role = part.role;
    return out;
  });
  if (req.task === "extend") {
    // Settlement is output minus this measured input, so it must be exact.
    const facts = object(measured) ? measured : {};
    if (typeof facts.seconds !== "number" || !Number.isFinite(facts.seconds)) {
      throw new Error("延长输入必须是可测量时长的非分片 MP4。");
    }
    if (facts.seconds < 1 || facts.seconds > EXTEND_MAX_INPUT_SECONDS) {
      throw new Error("延长输入视频时长必须在 1 到 30 秒之间；更长的视频请截取末尾片段（建议 10 秒）再延长。");
    }
    if (req.input_duration !== undefined && Math.abs(req.input_duration - facts.seconds) > 0.1) {
      throw new Error("输入视频时长与 MP4 不一致。");
    }
    return { content, input_seconds: Math.round(facts.seconds * 1000) / 1000 };
  }
  return { content };
}
function veoSubmit(ctx, req, conn) {
  const instance = { prompt: req.prompt };
  const ref = part => part.uri ? { gcsUri: part.uri, mimeType: part.mime_type }
    : { bytesBase64Encoded: part.data, mimeType: part.mime_type };
  for (const part of ingestedContent(ctx, req).content) {
    if (part.role === "first_frame") instance.image = ref(part);
    else if (part.role === "last_frame") instance.lastFrame = ref(part);
    else if (part.role === "video") instance.video = ref(part);
    else if (part.role === "reference") {
      instance.referenceImages = (instance.referenceImages || []).concat([{ image: ref(part), referenceType: "asset" }]);
    }
  }
  // storageUri keeps every resolution out of the inline response (Veo 4K is
  // >16MiB); extension inherits framing and adds a fixed 7s segment.
  const parameters = { sampleCount: 1, generateAudio: req.generate_audio, storageUri: outputPrefix(ctx.publicTaskId) };
  if (req.task !== "extend") {
    Object.assign(parameters, { durationSeconds: req.duration, aspectRatio: req.aspect_ratio, resolution: req.resolution });
  }
  if (req.negative_prompt) parameters.negativePrompt = req.negative_prompt;
  if (req.seed !== undefined) parameters.seed = req.seed;
  return { url: conn.veo + req.upstream + ":predictLongRunning", method: "POST", headers: conn.headers,
    body: { instances: [instance], parameters }, action: req.action };
}
export function buildSubmitRequest(ctx) {
  const sp = spec(ctx.model);
  const model = text(ctx.upstreamModel) || sp.upstream;
  if (model !== ctx.model && model !== sp.upstream) throw new Error("测试渠道只能映射到 " + sp.label + " 的精确上游型号。");
  // Revalidate original inputs rather than trusting a supplied normalized object.
  const req = normalize(ctx.requestBody, ctx.model);
  const conn = connection(ctx);
  if (req.family === "veo") return veoSubmit(ctx, req, conn);
  const format = { type: "video" };
  // Google REST response_format duration includes its seconds unit ("3s").
  // Keep ordinary generation's request billing numeric and unchanged.
  if (!["edit", "extend"].includes(req.task)) format.duration = String(req.duration) + "s";
  // Google rejects aspect_ratio and duration on edit/extend; the source video
  // determines framing and an extension always adds one fixed segment.
  if (!["edit", "extend"].includes(req.task)) {
    Object.assign(format, { aspect_ratio: req.aspect_ratio, resolution: req.resolution });
  }
  // The published edit example uses "output", but the real service rejects it
  // as an unknown parameter. Use the response_format resolution field.
  if (["edit", "extend"].includes(req.task) && req.explicit_resolution) format.resolution = req.resolution;
  // The JSON view omits large inline videos (verified 10s 4k); URI delivery
  // keeps every resolution and length out of NewAPI memory.
  Object.assign(format, { delivery: "uri", gcs_uri: outputPrefix(ctx.publicTaskId) });
  const body = {
    model: req.upstream,
    input: [{ type: "user_input", content: ingestedContent(ctx, req).content }],
    response_format: [format],
    background: true, store: true, stream: false,
  };
  // The real service forbids previous_interaction_id together with an
  // explicit video task. Continuations inherit the stored interaction mode.
  const generation = req.previous_interaction_id ? {} : { video_config: { task: req.task } };
  if (req.temperature !== undefined) generation.temperature = req.temperature;
  if (req.top_p !== undefined) generation.top_p = req.top_p;
  if (Object.keys(generation).length) body.generation_config = generation;
  if (req.previous_interaction_id) body.previous_interaction_id = req.previous_interaction_id;
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
  const response = object(body.response) ? body.response : {};
  for (const item of Array.isArray(response.videos) ? response.videos : []) {
    if (!object(item)) continue;
    const mime = text(item.mimeType) || "video/mp4";
    if (!VIDEO_MIMES.includes(mime)) continue;
    if (text(item.gcsUri).startsWith("gs://")) return video({ outputs: [{ type: "video", mime_type: mime, uri: item.gcsUri }] });
    if (text(item.bytesBase64Encoded)) return video({ outputs: [{ type: "video", mime_type: mime, data: item.bytesBase64Encoded }] });
    if (text(item.gcsUri)) return { invalid: true };
  }
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
        if (uri) return { invalid: true };
      }
    }
  }
  return null;
}
function familyOf(ctx) {
  const state = ctx.state || {};
  if (state.family === "veo" || state.family === "omni") return state.family;
  return Object.prototype.hasOwnProperty.call(MODELS, ctx.model) ? MODELS[ctx.model].family : "omni";
}
function billsOutputDuration(ctx) {
  // New continuations persist an explicit flag. Old tasks with no flag retain
  // their original request-duration contract; do not retroactively recharge.
  return ctx.action === "extend" || (ctx.state || {}).task === "extend" ||
    (ctx.state || {}).bill_output_duration === true;
}
// 1.3.0 extensions settle only the newly generated segment, which is what
// Google meters (identical output tokens for 10→20, 20→30 and 30→40s).
// Older extension snapshots keep their full-output contract.
function settledSeconds(state, outputSeconds) {
  if (state.bill_added_seconds !== true) return outputSeconds;
  const input = state.input_seconds;
  if (typeof input !== "number" || !Number.isFinite(input) || input <= 0) {
    throw new Error("延长输入时长缺失，无法按新增秒数结算。");
  }
  const added = Math.round((outputSeconds - input) * 1000) / 1000;
  if (!(added > 0)) throw new Error("延长成品未比输入更长，无法按新增秒数结算。");
  return added;
}
// Probe answers come from the transfer Worker, not Google: the interaction's
// output projection plus header-only MP4 facts. No bytes, tokens or hints.
function probeFacts(body, expectedURI) {
  if (body.error !== undefined) return { invalid: "成品时长探测暂不可用：" + (errors(body) || "未知错误") };
  const result = video(body);
  if (!result || result.uri !== expectedURI) return { invalid: "成品探测结果与输出地址不一致。" };
  const facts = object(body.facts) ? body.facts : {};
  if (typeof facts.seconds !== "number" || !Number.isFinite(facts.seconds) || facts.seconds <= 0 ||
      facts.seconds > 41 || !RESOLUTIONS.includes(facts.resolution)) {
    return { invalid: "成品的完整 MP4 时长或分辨率无法核验。" };
  }
  return { seconds: Math.round(facts.seconds * 1000) / 1000, resolution: billed(facts.resolution) };
}
function probeResult(ctx, body) {
  const state = ctx.state || {};
  if (!text(state.probe_uri)) return { status: "UNKNOWN", reason: "收到未请求的成品探测结果。" };
  // A probe outage is not a generation failure: keep polling, never refund.
  const facts = probeFacts(body, state.probe_uri);
  if (facts.invalid) return { status: "UNKNOWN", reason: facts.invalid };
  try { settledSeconds(state, facts.seconds); } catch (error) { return { status: "UNKNOWN", reason: error.message }; }
  const result = video(body);
  return { status: "SUCCESS", progress: "100%", url: result.url, remoteUrl: result.url,
    state: Object.assign({}, state, { output_seconds: facts.seconds, output_resolution: facts.resolution }) };
}
// A delivered result: extensions/continuations wait for the measured MP4;
// ordinary generation completes at once with request-based billing.
function delivered(ctx, result) {
  if (result.invalid) return { status: "FAILURE", progress: "100%", reason: "视频地址格式不安全或不受支持。" };
  if (billsOutputDuration(ctx)) {
    const state = ctx.state || {};
    if (result.uri && result.uri.startsWith("gs://")) {
      // Measure the stored MP4 header before settlement; never bill estimates.
      return { status: "IN_PROGRESS", progress: "95%", state: Object.assign({}, state, { probe_uri: result.uri }) };
    }
    const facts = result.data && mp4Facts(result.data);
    if (!facts) return { status: "UNKNOWN", reason: "成品的完整 MP4 时长无法核验，不能按预估时长完成结算。" };
    try { settledSeconds(state, facts.seconds); } catch (error) { return { status: "UNKNOWN", reason: error.message }; }
    return { status: "SUCCESS", progress: "100%", url: result.url, remoteUrl: result.url,
      state: Object.assign({}, state, { output_seconds: facts.seconds, output_resolution: facts.resolution }) };
  }
  return { status: "SUCCESS", progress: "100%", url: result.url, remoteUrl: result.url };
}
function veoResult(ctx, body) {
  const reason = errors(body);
  if (reason) return { status: "FAILURE", progress: "100%", reason };
  // Long-running operations omit `done` while running.
  if (body.done !== true) {
    return text(body.name) ? { status: "IN_PROGRESS", progress: "50%" } : { status: "UNKNOWN", reason: "无法识别 Veo 操作状态。" };
  }
  const result = video(body);
  if (!result) {
    const response = object(body.response) ? body.response : {};
    const reasons = (Array.isArray(response.raiMediaFilteredReasons) ? response.raiMediaFilteredReasons : []).map(text).filter(Boolean);
    return { status: "FAILURE", progress: "100%", reason: reasons.length ? reasons.join("; ")
      : Number(response.raiMediaFilteredCount) > 0 ? "Google 按使用政策过滤了生成结果。" : "Veo 已完成但未返回视频。" };
  }
  return delivered(ctx, result);
}
export function parseTaskResult(ctx, body) {
  if (!object(body)) return { status: "UNKNOWN", reason: "无法识别 Interaction 响应。" };
  if (body.object === "gcs_probe" || familyOf(ctx) !== "veo") {
    if (body.id !== undefined && ctx.taskId && body.id !== ctx.taskId) {
      return { status: "UNKNOWN", reason: "Interaction 编号与已提交任务不一致。" };
    }
  }
  if (body.object === "gcs_probe") return probeResult(ctx, body);
  if (familyOf(ctx) === "veo") return veoResult(ctx, body);
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
  if (!result) {
    // URI delivery always names the object. Only pre-1.3.0 inline snapshots
    // can lose a large video from the JSON view; that was already a failure.
    return { status: "FAILURE", progress: "100%", reason: "Interaction 已完成但未返回可读取的视频。" };
  }
  return delivered(ctx, result);
}
function veoSubmitted(ctx, req, body) {
  const operation = veoOperation(body.name);
  if (operation.upstream !== req.upstream) throw new Error("Veo 返回了非预期型号的操作，勿重复提交。");
  const inputSeconds = req.task === "extend" ? ingestedContent(ctx, req).input_seconds : undefined;
  const state = { family: "veo", seconds: req.duration, resolution: req.resolution, aspect_ratio: req.aspect_ratio,
    generate_audio: req.generate_audio };
  if (req.task === "extend") Object.assign(state, { input_seconds: inputSeconds, bill_added_seconds: true });
  if (req.task !== "text_to_video") state.task = req.task;
  // Persist a compact projection only; Veo always answers with an operation.
  return { taskId: b64url(operation.name), taskData: { name: operation.name }, state };
}
export function parseSubmitResponse(ctx, response) {
  const body = response.body;
  if (!object(body)) throw new Error("视频服务未返回有效 JSON，请核查是否已受理，勿重复提交。");
  const reason = errors(body);
  if (reason) throw new Error(reason);
  if (response.statusCode >= 400) throw new Error("视频服务返回 HTTP " + response.statusCode + "，请核查是否已受理，勿重复提交。");
  const req = normalize(ctx.requestBody, ctx.model);
  if (req.family === "veo") return veoSubmitted(ctx, req, body);
  const taskId = id(body.id);
  const inputSeconds = req.task === "extend" ? ingestedContent(ctx, req).input_seconds : undefined;
  const outputBillingState = req.previous_interaction_id ? { bill_output_duration: true }
    : req.task === "extend" ? { bill_added_seconds: true, input_seconds: inputSeconds } : {};
  const parsed = parseTaskResult({ taskId, action: req.task, state: outputBillingState }, body);
  if (parsed.status === "UNKNOWN") throw new Error(parsed.reason + " 请核查已受理任务，勿重复提交。");
  // Persist a compact projection only, never echoed inputs, thoughts or bytes.
  const taskData = { id: taskId, status: body.status };
  const result = video(body);
  if (parsed.status === "SUCCESS" && result && result.uri) taskData.outputs = [
    { type: "video", mime_type: result.mime, uri: result.uri },
  ];
  const state = { seconds: req.previous_interaction_id ? 40 : req.duration,
    resolution: req.resolution, aspect_ratio: req.aspect_ratio };
  if (req.previous_interaction_id) Object.assign(state, {
    bill_output_duration: true, requested_seconds: req.duration,
  });
  if (req.task === "extend") Object.assign(state, { input_seconds: inputSeconds, bill_added_seconds: true });
  if (req.task !== "text_to_video") state.task = req.task;
  if (parsed.state) Object.assign(state, parsed.state);
  const output = { taskId, taskData, state };
  if (parsed.status === "SUCCESS" || parsed.status === "FAILURE") output.immediate = parsed;
  return output;
}
export function buildQueryRequest(ctx) {
  const state = ctx.state || {};
  if (text(state.probe_uri)) {
    // Header-only measurement by the transfer Worker with its own read-only
    // bucket credential. Google OAuth is never sent outside Google.
    gcs(state.probe_uri);
    return { url: PROBE_URL + "?id=" + encodeURIComponent(id(ctx.taskId)) + "&uri=" + encodeURIComponent(state.probe_uri),
      method: "GET", headers: { Accept: "application/json" } };
  }
  const conn = connection(ctx);
  if (familyOf(ctx) === "veo") {
    const operation = veoOperation(unb64url(id(ctx.taskId)));
    return { url: conn.veo + operation.upstream + ":fetchPredictOperation", method: "POST", headers: conn.headers,
      body: { operationName: operation.name } };
  }
  return { url: conn.url + "/" + id(ctx.taskId), method: "GET", headers: conn.headers };
}
export function extractUsage(ctx) {
  const req = normalize(ctx.requestBody, ctx.model);
  // Veo bills seconds x resolution x audio; an extension reserves 8s (7s added).
  if (req.family === "veo") return { seconds: req.duration, resolution: req.resolution, generate_audio: req.generate_audio };
  // A continuation can return a concatenated video longer than the requested
  // new segment: reserve 40s, then settle the full returned MP4. An extension
  // reserves one segment, then settles measured output minus measured input.
  return { seconds: req.previous_interaction_id ? 40 : req.duration, resolution: req.resolution };
}
export function extractUsageOnComplete(ctx, result, data) {
  if (!billsOutputDuration(ctx)) return null;
  if (result.status !== "SUCCESS") return null;
  // Polling passes the pre-poll state, so facts come from this response:
  // a Worker probe, or a legacy inline MP4. Immediate completion stores a
  // measured projection in state. Never a client hint or token conversion.
  const state = ctx.state || {};
  let facts = null;
  if (object(data) && data.object === "gcs_probe") {
    const probed = probeFacts(data, state.probe_uri);
    if (!probed.invalid) facts = probed;
  } else {
    const output = object(data) ? video(data) : null;
    facts = output && output.data ? mp4Facts(output.data) : null;
  }
  if (!facts && Number.isFinite(state.output_seconds) && state.output_seconds > 0 && state.output_seconds <= 41 &&
      RESOLUTIONS.includes(state.output_resolution)) {
    facts = { seconds: state.output_seconds, resolution: state.output_resolution };
  }
  if (!facts) throw new Error("成品完整时长尚未核验。");
  const settled = { seconds: settledSeconds(state, facts.seconds), resolution: billed(facts.resolution) };
  if (familyOf(ctx) === "veo") settled.generate_audio = state.generate_audio !== false;
  return settled;
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
        for (const key of ["duration", "seconds", "seed"]) {
          if (typeof req[key] === "string" && /^\d+$/.test(req[key])) req[key] = Number(req[key]);
        }
        for (const key of ["generate_audio", "generateAudio"]) {
          if (req[key] === "true" || req[key] === "false") req[key] = req[key] === "true";
        }
        // Image files only; videos must be HTTP(S) links.
        for (const file of body.files || []) {
          const frame = ["first_frame", "firstFrame", "last_frame", "lastFrame"].includes(file.field);
          if (!frame && !["image", "images", "image[]", "images[]", "input_reference"].includes(file.field)) {
            throw new Error("multipart 只接受图片文件（input_reference/image/images/first_frame/last_frame），视频请传 HTTP(S) 链接。");
          }
          if (!Number.isSafeInteger(file.size) || file.size < 1 || file.size > IMAGE_LIMIT) throw new Error("上传图片大小必须在 20MiB 内。");
          // Clients often omit the part type or send octet-stream; fall back to the extension.
          let mime = text(file.mimeType).split(";")[0].trim().toLowerCase();
          if (!mime.startsWith("image/")) {
            const ext = (/\.([a-z0-9]+)$/i.exec(text(file.filename)) || [])[1];
            mime = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp" }[text(ext).toLowerCase()] || mime;
          }
          const reference = { __fileRef: file.ref, mimeType: mime };
          if (frame) {
            if (req[file.field] !== undefined) throw new Error("首尾帧文件字段不可重复。");
            req[file.field] = reference;
          } else {
            if (req.images !== undefined && !Array.isArray(req.images)) throw new Error("images必须为数组。");
            req.images = (req.images || []).concat([reference]);
          }
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
