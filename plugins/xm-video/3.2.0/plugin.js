const RATIOS = ["16:9", "9:16", "1:1", "4:3", "3:4"];
// Billing enum values, in display order. Every tier key must be listed here.
const RESOLUTIONS = ["480p", "720p", "768p", "1080p", "2k", "4k"];
// A series sells one name and bills the tier its request selects; a legacy
// fixed-tier name derives from its series and ignores requested resolutions.
// Each tier names the upstream ID used when the channel maps none and the
// quality spelling the upstream expects. Adding an upstream resolution is one
// tier here plus one branch in the series price expression.
const MODEL_CONFIGS = {};
const SERIES = [];
function tier(key, upstream, quality) {
  if (!RESOLUTIONS.includes(key)) throw new Error("undeclared resolution tier " + key);
  return { key: key, upstream: upstream, quality: quality || key };
}
function addModel(name, tiers, overrides, fixed) {
  MODEL_CONFIGS[name] = Object.assign({ tiers: tiers, fixed: !!fixed,
    defaultDuration: 5, minDuration: 4, maxDuration: 15, defaultRatio: "16:9",
    ratios: RATIOS.concat(["21:9"]), maxPrompt: Infinity, images: 9, videos: 3,
    audios: 3, framesExclusive: false, promptless: false, nativeMedia: false,
    generateAudio: false, visualWithAudio: false, totalMedia: 0 }, overrides);
}
// The first tier is the default when a request names no resolution.
function addSeries(name, tiers, overrides) { SERIES.push(name); addModel(name, tiers, overrides, false); }
function addFixed(name, series, key) {
  const cfg = MODEL_CONFIGS[series];
  MODEL_CONFIGS[name] = Object.assign({}, cfg, { tiers: cfg.tiers.filter(function (t) { return t.key === key; }), fixed: true });
}
addSeries("SD2.5", [tier("480p", "dvc-seedance-2.5-480p"), tier("720p", "dvc-seedance-2.5"),
  tier("1080p", "dvc-seedance-2.5-1080p")], {
  maxDuration: 30, defaultRatio: "auto", ratios: ["auto", "1:1", "21:9", "16:9", "9:16", "3:4", "4:3"],
  images: 30, videos: 10, audios: 10, framesExclusive: true, generateAudio: true,
  explicitRatioUpstream: "lltai-vs-2.5" });
// The upstream catalog spells the top SD2.0 quality "4K".
addSeries("SD2.0", [tier("480p", "cvd-seedance-2.0"), tier("720p", "cvd-seedance-2.0"),
  tier("1080p", "cvd-seedance-2.0"), tier("4k", "cvd-seedance-2.0", "4K")], {
  defaultRatio: "1:1", framesExclusive: true, promptless: true, totalMedia: 12 });
addSeries("kling-3.0-turbo", ["720p", "1080p", "2k", "4k"].map(function (key) { return tier(key, "kling-3.0-turbo"); }), {
  ratios: ["16:9", "9:16", "1:1"], maxPrompt: 2000, images: 30, videos: 10,
  audios: 0, nativeMedia: true, generateAudio: true });
addSeries("seedance-2.0-mini官方版", [tier("480p", "seedance-2.0-mini-480p"), tier("720p", "seedance-2.0-mini-720p")], {});
addSeries("seedance-2.5官方版", [tier("720p", "doubao-seedance-2-5-720p")], {
  defaultDuration: 4, maxDuration: 30, images: 30, videos: 10, audios: 10, framesExclusive: true });
addSeries("seedance-2.0官方版", [tier("720p", "doubao-seedance-2-0-720p")], { defaultDuration: 4, framesExclusive: true });
addSeries("seedance-2.0-fast官方版", [tier("720p", "doubao-seedance-2-0-fast-720p")], { defaultDuration: 4, framesExclusive: true });
for (const key of ["480p", "720p", "1080p"]) {
  addFixed("SD2.5 " + key.toUpperCase(), "SD2.5", key);
  addFixed("SD2.0 " + key.toUpperCase(), "SD2.0", key);
}
addFixed("SD2.0 4K", "SD2.0", "4k");
// Tasks created while the sales name was still lowercase "SD2.0 4k".
MODEL_CONFIGS["SD2.0 4k"] = MODEL_CONFIGS["SD2.0 4K"];
for (const key of ["720p", "1080p", "2k", "4k"]) addFixed("kling-3.0-turbo-" + key, "kling-3.0-turbo", key);
for (const key of ["480p", "720p"]) addFixed("seedance-2.0-mini-" + key, "seedance-2.0-mini官方版", key);
addFixed("Seedance-2.5-720p官方版", "seedance-2.5官方版", "720p");
addFixed("Seedance-2.0-720p官方版", "seedance-2.0官方版", "720p");
addFixed("Seedance-2.0-fast-720p官方版", "seedance-2.0-fast官方版", "720p");
for (const key of ["480p", "720p", "1080p"]) {
  const wan = "wan3.0-video-" + key;
  addModel(wan, [tier(key, wan)], { maxDuration: 30, ratios: RATIOS, promptless: true,
    images: key === "480p" ? 30 : 10, videos: key === "480p" ? 10 : 5,
    audios: key === "480p" ? 10 : 5, framesExclusive: key !== "480p" }, true);
}
addModel("minimax-h3-768p", [tier("768p", "minimax-h3-768p")], { defaultDuration: 4,
  ratios: ["1:1", "16:9", "9:16"], maxPrompt: 2500, images: 10, videos: 5,
  audios: 5, visualWithAudio: true }, true);
function usageSchema(keys) {
  return {
    seconds: { type: "number", unit: "second", description: { en: "Video generation unit price", zh: "视频生成单价" } },
    resolution: {
      enum: keys,
      enumLabels: Object.fromEntries(keys.map(function (key) { return [key, { en: key.toUpperCase(), zh: key.toUpperCase() }]; })),
      description: { en: "Output video resolution", zh: "输出视频分辨率" },
    },
  };
}
export const meta = {
  apiVersion: 1,
  key: "xm-video",
  name: "XM-Video",
  version: "3.2.0",
  author: { name: "88API" },
  description: { en: "88API channel integration plugin", zh: "88API渠道集成插件" },
  // Series names are declared only so each can carry its own resolution enum;
  // the model square lists exactly the tiers a series sells. Legacy fixed
  // names and future channel models stay dynamic on the superset schema.
  models: SERIES.slice(),
  dynamicModels: true,
  fetchMode: "per_task",
  protocols: ["openai_video"],
  usageSchema: usageSchema(RESOLUTIONS),
  usageProfiles: SERIES.map(function (name) {
    return { models: [name], schema: usageSchema(MODEL_CONFIGS[name].tiers.map(function (t) { return t.key; })) };
  }),
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
  if ((typeof value !== "number" && typeof value !== "string") || String(value).trim() === "") throw new Error("视频时长请输入整数秒数。");
  const seconds = Number(value);
  if (!Number.isInteger(seconds)) throw new Error("视频时长请输入整数秒数。");
  if (seconds < cfg.minDuration || seconds > cfg.maxDuration) throw new Error(cfg.maxDuration === Number.MAX_SAFE_INTEGER
    ? "视频时长请输入有效的正整数秒数。"
    : "视频时长需在 " + cfg.minDuration + " 到 " + cfg.maxDuration + " 秒之间。");
  if (cfg.durations && !cfg.durations.includes(seconds)) throw new Error("当前模型不支持该视频时长，请选择其他时长。");
  return seconds;
}
function modelConfig(model) {
  if (Object.prototype.hasOwnProperty.call(MODEL_CONFIGS, model)) return MODEL_CONFIGS[model];
  // Unknown models follow the standard contract without guessed capabilities.
  // Explicit duration keeps pre-consumption and the submitted quantity identical.
  return {
    upstream: model, tiers: null, minDuration: 1,
    maxDuration: Number.MAX_SAFE_INTEGER, defaultRatio: "", ratios: null,
    maxPrompt: Infinity, images: Infinity, videos: Infinity, audios: Infinity,
    promptless: true, generateAudio: true,
  };
}
function configFor(model, upstreamModel) {
  return modelConfig(Object.prototype.hasOwnProperty.call(MODEL_CONFIGS, model) ? model : upstreamModel || model);
}
function requestView(req) {
  let metadata;
  try { metadata = object(typeof req.metadata === "string" ? JSON.parse(req.metadata) : req.metadata); }
  catch (_error) { throw new Error("metadata 参数格式不正确，请提供有效的 JSON 对象。"); }
  return { metadata: metadata, all: Object.assign({}, metadata, req) };
}
// Only standard 16:9/9:16 frames name a tier; other sizes only imply a ratio.
const SIZE_TIERS = { "854x480": "480p", "480x854": "480p", "1280x720": "720p", "720x1280": "720p",
  "1920x1080": "1080p", "1080x1920": "1080p", "2560x1440": "2k", "1440x2560": "2k",
  "3840x2160": "4k", "2160x3840": "4k" };
// The billed tier and the upstream quality both come from here; an
// unsupported explicit resolution is rejected rather than downgraded.
function tierFor(all, cfg) {
  if (cfg.fixed) return cfg.tiers[0];
  const value = [all.resolution, all.quality, all.vquality].find(function (item) { return text(item) || Number.isFinite(item); });
  let key = value === undefined ? "" : String(value).trim().toLowerCase();
  if (/^\d+$/.test(key)) key += "p";
  const size = text(all.size).toLowerCase();
  if (!key && Object.prototype.hasOwnProperty.call(SIZE_TIERS, size)) key = SIZE_TIERS[size];
  if (!key) return cfg.tiers[0];
  const found = cfg.tiers.find(function (item) { return item.key === key; });
  if (!found) throw new Error("当前模型支持的分辨率：" + cfg.tiers.map(function (item) { return item.key.toUpperCase(); }).join("、") + "，请选择其中之一。");
  return found;
}
function payloadFor(req, model, upstreamModel) {
  const cfg = configFor(model, upstreamModel);
  const view = requestView(req);
  const metadata = view.metadata;
  const all = view.all;
  const tierChoice = cfg.tiers ? tierFor(all, cfg) : null;
  const sizeRatios = { "854x480": "16:9", "1280x720": "16:9", "1920x1080": "16:9", "2560x1440": "16:9", "3840x2160": "16:9", "480x854": "9:16", "720x1280": "9:16", "1080x1920": "9:16", "1440x2560": "9:16", "2160x3840": "9:16", "1024x1024": "1:1", "1440x1440": "1:1", "1920x1440": "4:3", "1440x1920": "3:4" };
  const requestedSize = first(all.size, req.size);
  const sizeRatio = (cfg.ratios || []).includes(requestedSize) ? requestedSize
    : sizeRatios[requestedSize] || (requestedSize === "3360x1440" ? "21:9" : "");
  const body = {
    model: upstreamModel && upstreamModel !== model ? upstreamModel : tierChoice ? tierChoice.upstream : cfg.upstream,
    ratio: first(all.ratio, all.aspect_ratio, sizeRatio, cfg.defaultRatio),
    duration: secondsFor(req, cfg),
    resolution: tierChoice ? tierChoice.quality : first(all.resolution, all.quality, all.vquality),
  };
  if (!body.resolution) delete body.resolution;
  if (!body.ratio) delete body.ratio;
  // VS2.5 requires an explicit supported ratio. Do not silently turn the
  // legacy SD2.5 "auto" default into 16:9, and keep legacy DVC behavior.
  const isVS25 = !!cfg.explicitRatioUpstream && body.model === cfg.explicitRatioUpstream;
  const requestedRatio = first(all.ratio, all.aspect_ratio, sizeRatio);
  if (isVS25 && !requestedRatio) throw new Error("请选择具体画幅比例后再提交，例如 16:9、9:16 或 1:1。");
  if (isVS25 && requestedRatio === "auto") throw new Error("当前模型不支持自动比例，请选择具体画幅比例。");
  if (isVS25) {
    body.ratio = requestedRatio;
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
        if (!text(value) && !(entry[0] === "referenceImages" && (object(value).__fileRef || cfg.nativeMedia && text(object(value).url)))) throw new Error(
          ({ referenceImages: "参考图片", referenceVideos: "参考视频", referenceAudios: "参考音频" })[entry[0]] + "内容为空或格式无效，请重新添加有效素材。");
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
    if (!Number.isSafeInteger(all.seed)) throw new Error("随机种子必须是整数。");
    body.seed = all.seed;
  }
  if (Object.keys(object(all.camera_control)).length) body.camera_control = Object.assign({}, all.camera_control);
  const generateAudio = all.generateAudio !== undefined && all.generateAudio !== null ? all.generateAudio : all.generate_audio;
  if (generateAudio !== undefined && generateAudio !== null) {
    if (!cfg.generateAudio) throw new Error("当前模型不支持音频开关，请移除该选项。");
    if (typeof generateAudio !== "boolean") throw new Error("音频开关参数无效，请选择开启或关闭。");
    body[cfg.nativeMedia ? "generate_audio" : "generateAudio"] = generateAudio;
  }
  if (!prompt && (!cfg.promptless || !images.length && !videos.length && !audios.length && !firstFrame && !lastFrame && !body.media)) throw new Error(cfg.promptless
    ? "请输入提示词，或添加当前模型支持的参考素材。"
    : "当前模型需要提示词，请填写后再提交。");
  if (Number.isFinite(cfg.maxPrompt) && Array.from(prompt).length > cfg.maxPrompt) {
    throw new Error("提示词过长，请控制在 " + cfg.maxPrompt + " 个字符以内。");
  }
  if (cfg.ratios && !cfg.ratios.includes(body.ratio)) throw new Error(body.ratio === "auto"
    ? "当前模型不支持自动比例，请选择具体画幅比例。"
    : "当前模型不支持该画幅比例，请选择：" + cfg.ratios.filter(function (ratio) { return !isVS25 || ratio !== "auto"; }).join("、") + "。");
  const imageCount = images.length + (cfg.nativeMedia ? Number(!!firstFrame) + Number(!!lastFrame) : 0);
  if (imageCount > cfg.images) throw new Error("参考图片过多，当前模型最多支持 " + cfg.images + " 张" + (cfg.nativeMedia ? "（含首尾帧）" : "") + "，请减少图片数量。");
  if (videos.length > cfg.videos) throw new Error(cfg.videos === 0 ? "当前模型不支持参考视频，请移除参考视频。" : "参考视频过多，当前模型最多支持 " + cfg.videos + " 个，请减少视频数量。");
  if (audios.length > cfg.audios) throw new Error(cfg.audios === 0 ? "当前模型不支持参考音频，请移除参考音频。" : "参考音频过多，当前模型最多支持 " + cfg.audios + " 段，请减少音频数量。");
  if (cfg.totalMedia && imageCount + videos.length + audios.length > cfg.totalMedia) throw new Error("参考素材总数超过当前模型限制，图片、视频和音频合计最多 " + cfg.totalMedia + " 个，请减少素材数量。");
  if (cfg.visualWithAudio && audios.length && !images.length && !videos.length && !firstFrame && !lastFrame) throw new Error("使用参考音频时，请至少同时添加一张图片、一个视频或首尾帧。");
  if (cfg.framesExclusive && (firstFrame || lastFrame) && (images.length || videos.length || audios.length)) throw new Error("首尾帧不能与普通参考图片、视频或音频同时使用。");
  if (lastFrame && !firstFrame) throw new Error("请先提供首帧，再提供尾帧。");
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
  if (!ctx.body || !["json", "multipart"].includes(ctx.body.kind)) throw new Error("请求格式不正确，请使用 JSON 或 multipart/form-data 提交。");
  let req;
  if (ctx.body.kind === "json") {
    if (!ctx.body.value || typeof ctx.body.value !== "object" || Array.isArray(ctx.body.value)) throw new Error("请求内容格式不正确，请提交一个 JSON 对象。");
    req = Object.assign({}, ctx.body.value);
  } else {
    req = {};
    for (const key of Object.keys(ctx.body.fields || {})) {
      const values = ctx.body.fields[key];
      if (values.length !== 1) throw new Error("参数重复提交，请检查“" + key + "”参数。");
      req[key] = values[0];
    }
    for (const key of ["metadata", "images", "videos", "audios", "image_urls", "video_urls", "audio_urls", "file_paths", "referenceImages", "reference_images", "referenceVideos", "reference_videos", "referenceAudios", "reference_audios", "media", "camera_control", "seed", "generateAudio", "generate_audio"]) {
      if (req[key] !== undefined) {
        try { req[key] = JSON.parse(req[key]); } catch (_error) { throw new Error("参数“" + key + "”格式不正确，请提供有效的 JSON。"); }
      }
    }
    const files = ctx.body.files || [];
    if (files.length > 1 || files.some(function (file) { return file.field !== "input_reference"; })) throw new Error("参考文件格式不正确，仅支持一个参考文件。");
    if (files.length) {
      if (req.images || req.image || req.input_reference) throw new Error("参考文件不能与图片参数同时使用，请只保留一种方式。");
      req.images = [{ __fileRef: files[0].ref, encoding: "dataUrl" }];
    }
  }
  if (typeof req.metadata === "string") {
    try { req.metadata = JSON.parse(req.metadata); } catch (_error) { throw new Error("metadata 参数格式不正确，请提供有效的 JSON 对象。"); }
  }
  if (req.metadata !== undefined && req.metadata !== null && (typeof req.metadata !== "object" || Array.isArray(req.metadata))) throw new Error("metadata 参数格式不正确，请提供 JSON 对象。");
  if (req.callback_url !== undefined && req.callback_url !== null && req.callback_url !== "") throw new Error("当前模型不支持回调地址，请移除 callback_url，并通过任务列表或 GET /v1/videos/{id} 查询结果。");
  delete req.callback_url;
  req.model = ctx.model;
  const payload = payloadFor(req, ctx.model);
  req.duration = payload.duration;
  delete req.seconds;
  // The host checks every request key named "resolution" against the usage
  // enum, so only the canonical tier key may remain under that name.
  const cfg = configFor(ctx.model);
  const tierKey = cfg.tiers ? tierFor(requestView(req).all, cfg).key : "";
  if (req.metadata && typeof req.metadata === "object") {
    req.metadata = Object.assign({}, req.metadata);
    delete req.metadata.resolution;
  }
  delete req.resolution;
  if (tierKey) req.resolution = tierKey;
  else if (payload.resolution) req.quality = payload.resolution;
  return { kind: "submit", model: ctx.model, action: payload.referenceImages || payload.referenceVideos || payload.referenceAudios || payload.firstFrame || payload.media || payload.images || payload.videos ? "image_to_video" : "text_to_video", requestBody: req };
}

function base(ctx) { return String(ctx.baseUrl).replace(/\/+$/, "").replace(/\/v1$/, ""); }
export function buildSubmitRequest(ctx) {
  return { url: base(ctx) + "/v1/videos/generations", method: "POST", headers: { Authorization: "Bearer " + ctx.apiKey, "Content-Type": "application/json" }, body: payloadFor(object(ctx.requestBody), ctx.model, ctx.upstreamModel) };
}
export function extractUsage(ctx) {
  const req = object(ctx.requestBody);
  const cfg = configFor(ctx.model, ctx.upstreamModel);
  const usage = { seconds: secondsFor(req, cfg) };
  if (cfg.tiers) usage.resolution = tierFor(requestView(req).all, cfg).key;
  return usage;
}

function taskBody(value) {
  const body = object(value);
  return body.status !== undefined || body.id || body.task_id ? body : object(body.data);
}
function errorMessage(body) { return first(object(body.error).message, body.error, body.message, "视频生成失败，请稍后重试。"); }
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
  if (!id) throw new Error("暂未获取到任务编号，无法确认提交结果，请联系管理员核查，勿重复提交。");
  return { taskId: id, taskData: response.body };
}
export function buildQueryRequest(ctx) {
  return { url: base(ctx) + "/v1/tasks/" + encodeURIComponent(ctx.taskId), method: "GET", headers: { Authorization: "Bearer " + ctx.apiKey, Accept: "application/json" } };
}
export function parseTaskResult(_ctx, value) {
  const body = taskBody(value);
  const statuses = { pending: "QUEUED", queued: "QUEUED", submitted: "QUEUED", processing: "IN_PROGRESS", in_progress: "IN_PROGRESS", running: "IN_PROGRESS", completed: "SUCCESS", success: "SUCCESS", succeeded: "SUCCESS", done: "SUCCESS", failed: "FAILURE", cancelled: "FAILURE", expired: "FAILURE" };
  const status = statuses[String(body.status || "").trim().toLowerCase()];
  if (!status) return { status: "UNKNOWN", reason: "暂时无法识别视频任务状态，请稍后查询，无需重新提交。" };
  const terminal = status === "SUCCESS" || status === "FAILURE";
  const progress = Number(String(body.progress || "0").replace(/%$/, ""));
  const result = { status: status, progress: terminal ? "100%" : (Number.isFinite(progress) ? Math.max(0, Math.min(99, Math.floor(progress))) : 0) + "%" };
  if (status === "SUCCESS") {
    const url = resultURL(body);
    if (!url) return { status: "FAILURE", progress: "100%", reason: "视频服务报告任务已完成，但未返回视频地址，请联系管理员核查。" };
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
  if (ctx.artifactKey !== "video" || !url) throw new Error("视频结果暂不可用，请稍后重试。");
  return { url: url, method: ctx.clientRequest.method, credentialless: true };
}
export const protocols = {
  openai_video: {
    decodeRequest: decodeRequest,
    render: function (_ctx, task) {
      const statuses = { NOT_START: "queued", SUBMITTED: "queued", QUEUED: "queued", IN_PROGRESS: "in_progress", SUCCESS: "completed", FAILURE: "failed" };
      const result = { id: task.task_id, object: "video", model: object(task.properties).origin_model_name || "", status: statuses[task.status] || "unknown", progress: Number(String(task.progress || "0").replace("%", "")), created_at: task.created_at };
      if (task.status === "SUCCESS" || task.status === "FAILURE") result.completed_at = task.updated_at;
      if (task.status === "FAILURE") result.error = { code: "video_generation_failed", message: task.fail_reason || "视频生成失败，请稍后重试。" };
      return result;
    },
  },
};
