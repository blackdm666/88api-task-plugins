// Derived from 88API's Minimax-H3 task plugin for NewAPI / QuantumNous.
// SPDX-License-Identifier: AGPL-3.0-or-later
// This is a separate driver: existing Minimax-H3 channels and persisted tasks are untouched.
export const meta = {
  apiVersion: 1,
  key: "h3-video",
  name: "H3-Video",
  description: { en: "MiniMax H3 video integration", zh: "MiniMax H3 视频集成" },
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

const UPSTREAM_MODEL = "minimax_h3";
const RESOLUTIONS = ["480p", "768p", "1080p", "2k", "4k"];
const SUPER_RESOLUTIONS = ["2k", "4k"];
// Unqualified sales names keep the previous plugin's fixed 768P tier.
const DEFAULT_RESOLUTION = "768p";
const DEFAULT_DURATION = 5;
const MIN_DURATION = 4;
const MAX_DURATION = 15;
const DEFAULT_RATIO = "16:9";
const RATIOS = ["16:9", "9:16", "1:1", "2:3", "3:2", "3:4", "4:3", "21:9"];
// Output sizes published by the upstream capability catalogue.
const SIZE_RATIOS = {
  "864x480": "16:9", "480x864": "9:16", "640x640": "1:1", "544x800": "2:3", "800x544": "3:2", "576x736": "3:4", "736x576": "4:3", "992x416": "21:9",
  "1376x768": "16:9", "1344x768": "16:9", "768x1376": "9:16", "1024x1024": "1:1", "832x1248": "2:3", "1248x832": "3:2", "896x1184": "3:4", "1184x896": "4:3", "1568x672": "21:9",
  "1920x1088": "16:9", "1088x1920": "9:16", "1440x1440": "1:1", "1184x1760": "2:3", "1760x1184": "3:2", "1248x1664": "3:4", "1664x1248": "4:3", "2208x960": "21:9",
};
const MAX_REFERENCE_IMAGES = 9;
const MAX_REFERENCE_VIDEOS = 3;
const MAX_REFERENCE_AUDIOS = 3;
const MAX_MEDIA_ITEMS = 12;
const MAX_FILE_BYTES = { image_url: 31457280, video_url: 52428800, audio_url: 15728640 };
// The upstream reports completed before its CDN link exists. Keep polling a
// bounded number of rounds instead of exposing the credentialed site route.
const MAX_LINK_WAIT_POLLS = 60;

function trimmed(value) {
  return typeof value === "string" ? value.trim() : "";
}

function object(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function normalizedBaseUrl(value) {
  const baseUrl = trimmed(value).replace(/\/+$/, "").replace(/\/(?:draw\/api\/)?v1$/, "");
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

function metadataFor(req) {
  if (req.metadata === undefined || req.metadata === null) return {};
  if (typeof req.metadata !== "object" || Array.isArray(req.metadata)) throw new Error("metadata 参数必须为 JSON 对象。");
  return req.metadata;
}

function mediaValue(value, type) {
  const label = { image_url: "图片", video_url: "视频", audio_url: "音频" }[type] || "素材";
  if (typeof value === "string") {
    const url = value.trim();
    if (!url) throw new Error(label + "地址不能为空，请提供有效的素材链接。");
    return url;
  }
  const item = object(value);
  if (typeof item.url === "string") return mediaValue(item.url, type);
  if (item.url !== undefined) return mediaValue(item.url, type);
  // Uploaded files stay host-owned; the host inlines them as data URLs.
  if (typeof item.__fileRef === "string" && item.__fileRef) {
    return { __fileRef: item.__fileRef, encoding: "dataUrl", maxBytes: MAX_FILE_BYTES[type] };
  }
  throw new Error(label + "格式不正确，请提供素材链接或有效的上传文件。");
}

function mediaItem(type, value, role) {
  return { type: type, role: role, url: mediaValue(value, type) };
}

function normalizeContentItem(item) {
  if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("素材内容格式不正确，请使用包含类型和内容的对象。");
  if (item.type === "text") return { type: "text", text: trimmed(item.text) };
  if (item.type === "image_url") return mediaItem("image_url", item.image_url !== undefined ? item.image_url : item.url, trimmed(item.role));
  if (item.type === "video_url") return mediaItem("video_url", item.video_url !== undefined ? item.video_url : item.url, trimmed(item.role) || "reference_video");
  if (item.type === "audio_url") return mediaItem("audio_url", item.audio_url !== undefined ? item.audio_url : item.url, trimmed(item.role) || "reference_audio");
  throw new Error("不支持该素材类型，请使用文本、图片、视频或音频。");
}

function normalizeMediaEntry(entry) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error("素材条目格式不正确，请提供素材类型和链接。");
  const role = trimmed(entry.role) || trimmed(entry.type);
  const value = entry.url !== undefined ? entry.url : entry.uri;
  if (role === "first_frame" || role === "last_frame" || role === "reference_image") {
    return mediaItem("image_url", entry.image_url !== undefined ? entry.image_url : value, role);
  }
  if (role === "reference_video") return mediaItem("video_url", entry.video_url !== undefined ? entry.video_url : value, role);
  if (role === "reference_audio") return mediaItem("audio_url", entry.audio_url !== undefined ? entry.audio_url : value, role);
  if (entry.type === "image_url" || entry.type === "video_url" || entry.type === "audio_url") return normalizeContentItem(entry);
  throw new Error("素材用途无效，请指定首帧、尾帧、参考图片、参考视频或参考音频。");
}

// Upstream-style references: {type: image|video|audio, role: reference|first_frame|last_frame, url}.
function normalizeReference(entry) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error("素材条目格式不正确，请提供素材类型和链接。");
  const type = { image: "image_url", video: "video_url", audio: "audio_url" }[trimmed(entry.type)];
  if (!type) throw new Error("不支持该素材类型，请使用图片、视频或音频。");
  const role = trimmed(entry.role) || "reference";
  if (role === "first_frame" || role === "last_frame") {
    if (type !== "image_url") throw new Error("首尾帧只能使用图片素材。");
    return mediaItem(type, entry.url, role);
  }
  if (role !== "reference") throw new Error("素材用途无效，请使用 reference、first_frame 或 last_frame。");
  return mediaItem(type, entry.url, { image_url: "reference_image", video_url: "reference_video", audio_url: "reference_audio" }[type]);
}

function appendItems(target, type, role, values) {
  for (const value of values) target.push(mediaItem(type, value, role));
}

function assembledContent(req, metadata) {
  const prompt = trimmed(req.prompt);
  const content = metadata.content !== undefined && metadata.content !== null ? metadata.content : req.content;
  const sources = [content !== undefined && content !== null, Array.isArray(req.media) && req.media.length > 0, req.references !== undefined && req.references !== null];
  if (sources.filter(Boolean).length > 1) throw new Error("请只使用一组素材参数，避免重复或遗漏素材。");

  if (content !== undefined && content !== null) {
    if (!Array.isArray(content)) throw new Error("素材列表格式不正确，metadata.content 必须是数组。");
    const items = content.map(normalizeContentItem);
    if (!items.some(function (item) { return item.type === "text"; }) && prompt) items.unshift({ type: "text", text: prompt });
    return items;
  }

  const items = [];
  if (prompt) items.push({ type: "text", text: prompt });

  if (Array.isArray(req.media) && req.media.length) {
    for (const item of req.media) items.push(normalizeMediaEntry(item));
    return items;
  }
  if (req.references !== undefined && req.references !== null) {
    if (!Array.isArray(req.references)) throw new Error("references 必须是数组。");
    for (const item of req.references) items.push(normalizeReference(item));
    return items;
  }

  const firstFrame = firstValues(metadata.first_frame_image, metadata.firstFrame, metadata.first_image);
  const lastFrame = firstValues(metadata.last_frame_image, metadata.lastFrame, metadata.last_image);
  if (firstFrame.length || lastFrame.length) {
    appendItems(items, "image_url", "first_frame", firstFrame);
    appendItems(items, "image_url", "last_frame", lastFrame);
  } else {
    const frames = firstValues(req.images, req.image, req.input_reference);
    if (frames.length > 2) throw new Error("首尾帧模式最多支持 2 张图片，请分别提供首帧和尾帧。");
    if (frames.length > 0) items.push(mediaItem("image_url", frames[0], "first_frame"));
    if (frames.length > 1) items.push(mediaItem("image_url", frames[1], "last_frame"));
  }

  appendItems(items, "image_url", "reference_image", firstValues(metadata.reference_images, metadata.referenceImages, metadata.reference_image));
  appendItems(items, "video_url", "reference_video", firstValues(req.videos, req.video, metadata.reference_videos, metadata.referenceVideos, metadata.reference_video));
  appendItems(items, "audio_url", "reference_audio", firstValues(metadata.reference_audios, metadata.referenceAudios, metadata.reference_audio));
  return items;
}

function validateContent(content) {
  let prompt = "";
  let textCount = 0;
  let firstFrames = 0;
  let lastFrames = 0;
  let referenceImages = 0;
  let referenceVideos = 0;
  let referenceAudios = 0;
  const unroledImages = [];

  for (let index = 0; index < content.length; index += 1) {
    const item = content[index];
    if (item.type === "text") {
      textCount += 1;
      if (!item.text) throw new Error("提示词不能为空，请输入视频内容描述。");
      prompt = item.text;
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
  if (lastFrames && !firstFrames) throw new Error("尾帧必须和首帧一起使用，请补充首帧图片。");
  if (referenceImages > MAX_REFERENCE_IMAGES) throw new Error("参考图片最多 9 张，请减少后提交。");
  if (referenceVideos > MAX_REFERENCE_VIDEOS) throw new Error("参考视频最多 3 个，请减少后提交。");
  if (referenceAudios > MAX_REFERENCE_AUDIOS) throw new Error("参考音频最多 3 段，请减少后提交。");

  const frameCount = firstFrames + lastFrames;
  const referenceCount = referenceImages + referenceVideos + referenceAudios;
  if (frameCount && referenceCount) throw new Error("首尾帧不能与参考素材混用，请选择首尾帧模式或参考素材模式。");
  if (frameCount + referenceCount > MAX_MEDIA_ITEMS) throw new Error("参考素材合计最多 12 个，请减少图片、视频或音频数量。");
  return { prompt: prompt, media: content.filter(function (item) { return item.type !== "text"; }), frames: frameCount > 0, references: referenceCount > 0 };
}

function integer(value, label, min, max) {
  if ((typeof value !== "number" && typeof value !== "string") || (typeof value === "string" && !/^\s*-?\d+\s*$/.test(value))) {
    throw new Error(label + "需为 " + min + " 到 " + max + " 之间的整数，请调整后提交。");
  }
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < min || number > max) {
    throw new Error(label + "需为 " + min + " 到 " + max + " 之间的整数，请调整后提交。");
  }
  return number;
}

// The same validated value is sent upstream and used as the billing quantity.
function durationFor(req, metadata) {
  const values = [req.duration, req.seconds, metadata.duration, metadata.seconds].filter(function (value) {
    return value !== undefined && value !== null && value !== "";
  });
  let duration;
  for (const value of values) {
    const seconds = integer(value, "视频时长", MIN_DURATION, MAX_DURATION);
    if (duration !== undefined && seconds !== duration) throw new Error("视频时长参数不一致，请统一 duration 与 seconds。");
    duration = seconds;
  }
  return duration === undefined ? DEFAULT_DURATION : duration;
}

function resolutionPin(name) {
  const match = /(?:^|[-_ ])(480p|768p|1080p|2k|4k)$/i.exec(trimmed(name));
  return match ? match[1].toLowerCase() : "";
}

function outputSelector(req) {
  const ratio = trimmed(object(req.output).ratio).toLowerCase();
  if (!ratio) return null;
  const match = /^(480p|768p|1080p|2k|4k)-(\d+)x(\d+)$/.exec(ratio);
  if (!match) throw new Error("output.ratio 格式不正确，例如 1080p-16x9。");
  return { resolution: match[1], ratio: match[2] + ":" + match[3] };
}

// Sales identity owns the paid resolution; request fields may only confirm it.
function resolutionFor(ctx, req, metadata) {
  const publicPin = resolutionPin(ctx.model);
  const upstreamPin = resolutionPin(ctx.upstreamModel);
  if (publicPin && upstreamPin && publicPin !== upstreamPin) throw new Error("模型映射的分辨率与销售型号不一致，请联系管理员。");
  const fixed = publicPin || upstreamPin;
  const selector = outputSelector(req);
  const values = [req.resolution, metadata.resolution, selector && selector.resolution];
  if (/^\d+p$|^[24]k$/i.test(trimmed(req.size))) values.push(req.size);
  let explicit = "";
  for (const value of values) {
    if (value === undefined || value === null || value === "") continue;
    const quality = trimmed(value).toLowerCase();
    if (!RESOLUTIONS.includes(quality)) throw new Error("请选择 480p、768p、1080p、2k 或 4k 分辨率。");
    if ((fixed && quality !== fixed) || (explicit && quality !== explicit)) throw new Error("请求分辨率与销售型号或其他分辨率参数冲突。");
    explicit = quality;
  }
  if (!fixed && explicit && explicit !== DEFAULT_RESOLUTION) throw new Error("请使用对应分辨率的模型名称。");
  return fixed || DEFAULT_RESOLUTION;
}

function greatestCommonDivisor(a, b) {
  return b ? greatestCommonDivisor(b, a % b) : a;
}

function sizeRatio(size) {
  if (Object.prototype.hasOwnProperty.call(SIZE_RATIOS, size)) return SIZE_RATIOS[size];
  const dimensions = /^(\d+)x(\d+)$/.exec(size);
  if (!dimensions) throw new Error("尺寸格式无效，请使用如 1920x1080 的宽x高格式。");
  const width = Number(dimensions[1]);
  const height = Number(dimensions[2]);
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0) throw new Error("视频尺寸必须为正整数。");
  const divisor = greatestCommonDivisor(width, height);
  const reduced = width / divisor + ":" + height / divisor;
  const ratio = RATIOS.find(function (item) {
    const parts = item.split(":").map(Number);
    const d = greatestCommonDivisor(parts[0], parts[1]);
    return parts[0] / d + ":" + parts[1] / d === reduced;
  });
  if (!ratio) throw new Error("当前模型不支持该画幅比例，请选择：" + RATIOS.join("、") + "。");
  return ratio;
}

function ratioFor(req, metadata) {
  const selector = outputSelector(req);
  const values = [req.ratio, req.aspect_ratio, req.aspectRatio, metadata.ratio, metadata.aspect_ratio, metadata.aspectRatio, selector && selector.ratio];
  const size = trimmed(req.size).toLowerCase();
  if (size && !/^\d+p$|^[24]k$/.test(size)) values.push(sizeRatio(size));
  let selected = "";
  for (const value of values) {
    if (value === undefined || value === null || value === "") continue;
    const ratio = trimmed(value);
    if (ratio === "adaptive") throw new Error("当前模型不支持自适应比例，请选择具体画幅比例。");
    if (!RATIOS.includes(ratio)) throw new Error("当前模型不支持该画幅比例，请选择：" + RATIOS.join("、") + "。");
    if (selected && selected !== ratio) throw new Error("画幅比例参数冲突，请只提供一致的比例。");
    selected = ratio;
  }
  return selected || DEFAULT_RATIO;
}

function workflowFor(req, metadata, resolution, content) {
  const superResolution = SUPER_RESOLUTIONS.includes(resolution);
  let workflow;
  if (content.frames) workflow = superResolution ? "cf-fl2v" : "fl2v";
  else if (content.references) workflow = superResolution ? "cf-multi-reference" : "multi-reference";
  // 2K/4K are produced by the upstream upscaling workflows; text-only requests use cf-multi-reference.
  else workflow = superResolution ? "cf-multi-reference" : "text-to-video";
  for (const value of [req.workflow_id, metadata.workflow_id]) {
    if (value !== undefined && value !== null && value !== "" && trimmed(value) !== workflow) {
      throw new Error("workflow_id 与素材或分辨率不匹配，当前应为 " + workflow + "，也可省略由系统自动选择。");
    }
  }
  return workflow;
}

function promptEnhanceFor(req, metadata) {
  const values = [req.prompt_enhance, metadata.prompt_enhance].filter(function (value) { return value !== undefined && value !== null && value !== ""; });
  let selected;
  for (const value of values) {
    const flag = value === true || value === "true" ? true : value === false || value === "false" ? false : undefined;
    if (flag === undefined) throw new Error("prompt_enhance 必须为 true 或 false。");
    if (selected !== undefined && selected !== flag) throw new Error("prompt_enhance 参数冲突。");
    selected = flag;
  }
  return selected;
}

function upstreamModelFor(ctx) {
  const name = trimmed(ctx.upstreamModel);
  // Channel mappings may pin a published upstream variant such as minimax_h3-03.
  return /^minimax_h3(?:-\d{2})?$/.test(name) ? name : UPSTREAM_MODEL;
}

function normalizedRequest(ctx) {
  const req = ctx.requestBody || {};
  const metadata = metadataFor(req);
  const resolution = resolutionFor(ctx, req, metadata);
  const content = validateContent(assembledContent(req, metadata));
  const body = {
    model: upstreamModelFor(ctx),
    prompt: content.prompt,
    seconds: durationFor(req, metadata),
    workflow_id: workflowFor(req, metadata, resolution, content),
    output: { ratio: resolution + "-" + ratioFor(req, metadata).replace(":", "x") },
  };
  if (content.media.length) {
    body.references = content.media.map(function (item) {
      return {
        type: item.type.replace("_url", ""),
        role: item.role === "first_frame" || item.role === "last_frame" ? item.role : "reference",
        url: item.url,
      };
    });
  }
  const promptEnhance = promptEnhanceFor(req, metadata);
  if (promptEnhance !== undefined) body.prompt_enhance = promptEnhance;
  return body;
}

function actionFor(body) {
  if (!body.references) return "text_to_video";
  return body.references.some(function (item) { return item.role === "reference"; }) ? "reference_to_video" : "image_to_video";
}

export function buildSubmitRequest(ctx) {
  const body = normalizedRequest(ctx);
  const headers = { "Content-Type": "application/json", Accept: "application/json", Authorization: "Bearer " + ctx.apiKey };
  // The upstream deduplicates by Idempotency-Key, so host retries reuse one generation.
  const idempotencyKey = trimmed(ctx.publicTaskId);
  if (/^[A-Za-z0-9._:-]{8,128}$/.test(idempotencyKey)) headers["Idempotency-Key"] = idempotencyKey;
  return { url: normalizedBaseUrl(ctx.baseUrl) + "/v1/videos", method: "POST", headers: headers, body: body, action: actionFor(body) };
}

export function extractUsage(ctx) {
  if (ctx.usagePurpose === "billing_ratios") return null;
  return { seconds: normalizedRequest(ctx).seconds };
}

export function extractUsageOnComplete() {
  // The query response has no billed duration; keep the frozen, validated request seconds.
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

function failureReason(body) {
  return apiErrorMessage(body) || trimmed(body.status_message) || "视频生成失败，服务端未提供具体原因，请联系管理员。";
}

export function parseSubmitResponse(_ctx, response) {
  const body = object(response.body);
  const taskId = trimmed(body.id) || trimmed(body.task_id);
  if (!taskId) {
    throw new Error(apiErrorMessage(body) || "视频服务未返回任务编号，请联系管理员确认是否已受理，勿重复提交。");
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
    const message = apiErrorMessage(body);
    return { status: "UNKNOWN", reason: message || "暂未获取到视频任务信息，请稍后查询，无需重新提交生成。" };
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

const FILE_FIELDS = {
  first_frame: ["image", "first_frame"], first_frame_image: ["image", "first_frame"], start_frame: ["image", "first_frame"],
  last_frame: ["image", "last_frame"], last_frame_image: ["image", "last_frame"], end_frame: ["image", "last_frame"],
  input_reference: ["image", "frames"], image: ["image", "frames"], images: ["image", "frames"],
  reference_image: ["image", "reference_images"], reference_images: ["image", "reference_images"],
  video: ["video", "reference_videos"], videos: ["video", "reference_videos"], reference_video: ["video", "reference_videos"], reference_videos: ["video", "reference_videos"],
  audio: ["audio", "reference_audios"], audios: ["audio", "reference_audios"], reference_audio: ["audio", "reference_audios"], reference_audios: ["audio", "reference_audios"],
};
const METADATA_FILE_TARGETS = { first_frame: "first_frame_image", last_frame: "last_frame_image", reference_images: "reference_images", reference_videos: "reference_videos", reference_audios: "reference_audios" };

function multipartRequest(body) {
  const request = {};
  const fields = body.fields || {};
  for (const name of Object.keys(fields)) {
    const values = fields[name] || [];
    if (values.length !== 1) throw new Error("参数重复提交：" + name);
    request[name] = values[0];
  }
  for (const name of ["metadata", "media", "content", "references", "output", "images", "videos"]) {
    if (request[name] === undefined) continue;
    try {
      request[name] = JSON.parse(request[name]);
    } catch (_error) {
      if (name === "images" || name === "videos") continue;
      throw new Error(name + " 必须为有效的 JSON。");
    }
  }
  const metadata = Object.assign({}, object(request.metadata));
  const frames = [];
  for (const file of body.files || []) {
    const target = FILE_FIELDS[trimmed(file.field).replace(/\[\]$/, "")];
    if (!target || !trimmed(file.ref) || !new RegExp("^" + target[0] + "/").test(file.mimeType || "")) {
      throw new Error("请上传有效的首尾帧、参考图片、参考视频或参考音频文件。");
    }
    const placeholder = { __fileRef: file.ref, encoding: "dataUrl" };
    if (target[1] === "frames") frames.push(placeholder);
    else {
      const key = METADATA_FILE_TARGETS[target[1]];
      metadata[key] = asArray(metadata[key]).concat([placeholder]);
    }
  }
  if (frames.length) request.images = asArray(request.images).concat(frames);
  if ((body.files || []).length) request.metadata = metadata;
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
      // Validate the exact upstream contract before channel selection and billing.
      const canonical = normalizedRequest(Object.assign({}, ctx, { requestBody: request }));
      return { kind: "submit", model: ctx.model, action: actionFor(canonical), requestBody: Object.assign({}, canonical, { model: ctx.model }) };
    },
    render: function (_ctx, task) {
      return renderOpenAIVideo(task);
    },
  },
};
