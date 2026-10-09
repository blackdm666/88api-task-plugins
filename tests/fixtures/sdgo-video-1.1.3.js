const RATIOS = ["16:9", "4:3", "1:1", "3:4", "9:16", "21:9", "adaptive"];
const RESOLUTIONS = ["480p", "720p", "1080p", "4k"];
const VIDEO_INPUTS = ["none", "present"];
const TASK_TYPES = ["auto", "reference", "edit", "extend"];
const DEFAULT_MAX_DURATION = 30;
const CATALOG_MODELS = [
  "doubao-seedance-2-0-mini-260615",
  "doubao-seedance-2-0-260128",
  "doubao-seedance-2-0-fast-260128",
  "doubao-seedance-2-5-260628",
];

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

function usageSchema(resolutions) {
  return {
    seconds: {
      type: "number",
      unit: "second",
      description: { en: "Video generation unit price", zh: "视频生成单价" },
    },
    resolution: {
      enum: resolutions,
      enumLabels: Object.fromEntries(resolutions.map((value) => [value, { en: value, zh: value }])),
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
      description: { en: "Completed output token unit price", zh: "完成任务输出 Token 单价" },
    },
  };
}

function usageExamples(resolutions) {
  const secondResolution = resolutions[Math.min(1, resolutions.length - 1)];
  const lastResolution = resolutions[resolutions.length - 1];
  return [
    {
      label: `5s · ${secondResolution} · 无参考视频`,
      facts: { seconds: 5, resolution: secondResolution, video_input: "none", upstreamUnits: 216900 },
    },
    {
      label: `10s · ${lastResolution} · 有参考视频`,
      facts: { seconds: 10, resolution: lastResolution, video_input: "present", upstreamUnits: 216900 },
    },
  ];
}

export const meta = {
  apiVersion: 1,
  key: "sdgo-video",
  name: "SD-Video",
  version: "1.1.3",
  author: { name: "88API" },
  description: {
    en: "Seedance video generation through the SDGO OpenAI-compatible task API",
    zh: "通过 SDGO OpenAI 兼容任务接口接入 Seedance 视频生成",
  },
  models: CATALOG_MODELS,
  dynamicModels: true,
  fetchMode: "per_task",
  allowedHosts: ["sdgotop.tos-cn-beijing.volces.com"],
  requiredCapabilities: ["task-preflight@1"],
  protocols: ["openai_video"],
  usageSchema: usageSchema(RESOLUTIONS),
  usageExamples: usageExamples(RESOLUTIONS),
  usageProfiles: [
    {
      models: ["doubao-seedance-2-0-mini-260615", "doubao-seedance-2-0-fast-260128"],
      schema: usageSchema(["480p", "720p"]),
      examples: usageExamples(["480p", "720p"]),
    },
    {
      models: ["doubao-seedance-2-0-260128"],
      schema: usageSchema(["480p", "720p", "1080p", "4k"]),
      examples: usageExamples(["480p", "720p", "1080p", "4k"]),
    },
    {
      models: ["doubao-seedance-2-5-260628"],
      schema: usageSchema(["480p", "720p", "1080p"]),
      examples: usageExamples(["480p", "720p", "1080p"]),
    },
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
    if (typeof value.__fileRef === "string") {
      url = value;
    } else {
      url = typeof value.url === "object" && value.url !== null
        ? value.url
        : text(value.url);
      role = text(value.role);
    }
  }
  const providerAsset = typeof url === "string" && /^asset:\/\//i.test(url);
  const providerUpload = typeof url === "string" && /^tos:\/\//i.test(url);
  const filePlaceholder = url && typeof url === "object" && !Array.isArray(url) &&
    typeof url.__fileRef === "string" && ["base64", "dataUrl"].includes(url.encoding);
  const allowed = kind === "video"
    ? /^https:\/\//i.test(url) || providerAsset || providerUpload
    : /^https:\/\//i.test(url) || providerAsset || providerUpload || /^data:/i.test(url) || filePlaceholder;
  if (!url || !allowed) {
    throw new Error(field + "必须是可被网关和上游访问的 HTTPS、asset://、tos:// 或受支持的内联数据地址。");
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

function hasAssetSource(items) {
  return items.some((item) => {
    const type = text(item.type);
    const media = object(item[type]);
    const url = media.url;
    return typeof url === "string" && /^(asset|tos):\/\//i.test(url);
  });
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
  "__sdgo_auto_duration",
]);

function copyForwardFields(body, all) {
  // Preserve provider-native fields verbatim. In particular, callback_url is
  // supplied by the caller and must reach SDGO/Ark unchanged; it is not a
  // NewAPI callback endpoint and must not be rewritten by this adapter.
  for (const [key, value] of Object.entries(all)) {
    if (!COMPATIBILITY_KEYS.has(key) && key !== "model" && body[key] === undefined) body[key] = value;
  }
  return body;
}

function payloadFor(request, model, upstreamModel, options = {}) {
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
  const requestedTaskType = first(all.omni_reference_task_type, all.omniReferenceTaskType);
  const duration = all.__sdgo_auto_duration === true
    ? -1
    : durationFor(all.duration !== undefined ? all.duration : all.seconds, cfg);
  if (duration === -1 && (cfg.family === "1.0" || cfg.family === "1.0-fast")) {
    throw new Error("Seedance 1.0 不支持 -1 时长。");
  }
  const resolution = resolutionFor(first(all.resolution, all.quality, all.vquality), cfg);
  const ratio = ratioFor(first(all.ratio, all.aspect_ratio), cfg, hasFrame);
  const body = { model: upstream, content, resolution, ratio };
  if (duration === -1 && options.hostSafe) {
    // NewAPI validates the decoded request recursively before it calls the
    // provider. Its canonical duration/seconds fields cannot be negative,
    // while SDGO uses duration=-1 to request provider-selected duration.
    // Keep an internal marker in the host request and restore -1 at submit.
    body.__sdgo_auto_duration = true;
  } else {
    body.duration = duration;
  }
  // SDGO requires asset mode for provider asset references. Keep an
  // explicitly supplied mode (including direct_url) untouched; only infer
  // the mode when the request actually contains asset:// or tos:// media.
  if (!first(all.image_source_mode) && hasAssetSource(media.images)) {
    body.image_source_mode = "asset";
  }
  if (!first(all.video_source_mode) && hasAssetSource(media.videos)) {
    body.video_source_mode = "asset";
  }
  const taskType = requestedTaskType;
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

function normalizeImplicitVideoEdit(body) {
  const value = object(body);
  const model = text(value.model);
  const cfg = modelConfig(model);
  if (!cfg.omni) return value;
  const media = parseMediaFromContent(Array.isArray(value.content) ? value.content : []);
  const taskType = first(value.omni_reference_task_type, value.omniReferenceTaskType);
  // Seedance 2.5 may classify an otherwise "auto" reference-video prompt as
  // video editing. SDGO then requires duration=-1 and derives the duration
  // from the selected input video. Apply this only to the provider submission
  // body so NewAPI's estimate can still use the caller's requested duration.
  if (media.videos.length && (!taskType || taskType === "auto")) {
    value.duration = -1;
  }
  return value;
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
  const files = ctx.body.files || [];
  if (files.length) {
    if (files.length !== 1 || !/^image\//i.test(text(files[0].mimeType))) {
      throw new Error("SDGO 仅可将一个本地图片文件内联为图片素材；本地视频请先上传到 SDGO，再提交 tos:// 或 asset:// 地址。");
    }
    if (req.images || req.image || req.image_urls || req.content) {
      throw new Error("本地图片文件不能与图片或 content 参数同时使用，请只保留一种方式。");
    }
    req.images = [{
      __fileRef: files[0].ref,
      encoding: "dataUrl",
      mimeType: files[0].mimeType,
    }];
  }
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
  const body = payloadFor(req, ctx.model, ctx.upstreamModel, { hostSafe: true });
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

function imageFileRefs(value, refs = new Set()) {
  if (Array.isArray(value)) {
    for (const item of value) imageFileRefs(item, refs);
    return refs;
  }
  if (!value || typeof value !== "object") return refs;
  const media = value.image_url;
  const url = media && typeof media === "object" ? media.url : null;
  if (url && typeof url === "object" && typeof url.__fileRef === "string") refs.add(url.__fileRef);
  for (const item of Object.values(value)) imageFileRefs(item, refs);
  return refs;
}

function localImageFiles(ctx) {
  const refs = [...imageFileRefs(ctx && ctx.requestBody)];
  const files = Array.isArray(ctx && ctx.files) ? ctx.files : [];
  const result = refs.map((ref) => files.find((file) => file && file.ref === ref));
  if (result.some((file) => !file)) throw new Error("SDGO 本地图片素材引用无效，找不到对应上传文件。");
  if (result.length > 1) throw new Error("SDGO 当前插件单次请求仅支持一个本地图片素材，请改用公网图片或拆分请求。");
  return result;
}

function localImageFile(ctx) {
  return localImageFiles(ctx)[0];
}

function preflightData(ctx) {
  return object(object(ctx.preflightResponse).data);
}

function uploadedAssetSource(ctx) {
  const source = text(preflightData(ctx).source);
  return /^tos:\/\//i.test(source) || /^asset:\/\//i.test(source) ? source : "";
}

function requestWithAssetImage(request, file, source) {
  const body = JSON.parse(JSON.stringify(request));
  const content = Array.isArray(body.content) ? body.content : [];
  let replaced = false;
  for (const item of content) {
    if (!item || item.type !== "image_url" || !item.image_url || typeof item.image_url !== "object") continue;
    const url = item.image_url.url;
    if (!url || typeof url !== "object" || url.__fileRef !== file.ref) continue;
    item.image_url.url = source;
    replaced = true;
  }
  if (!replaced) throw new Error("未找到本地图片素材，无法转换为 SDGO 素材库引用。");
  body.image_source_mode = "asset";
  return body;
}

export function buildPreflightRequest(ctx) {
  const file = localImageFile(ctx);
  if (!file) return null;
  if (!ctx.apiKey) throw new Error("SDGO 素材库上传需要渠道 API Key。");
  return {
    url: base(ctx) + "/v1/seedance/uploads/presign",
    method: "POST",
    headers: {
      Authorization: "Bearer " + ctx.apiKey,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: {
      filename: file.filename,
      size: file.size,
      content_type: text(file.mimeType) || "application/octet-stream",
    },
  };
}

export function buildUploadRequest(ctx) {
  const file = localImageFile(ctx);
  if (!file || !ctx.preflightResponse) return null;
  const data = preflightData(ctx);
  const uploadURL = text(data.upload_url);
  if (!uploadURL) throw new Error("SDGO 素材库预签名响应缺少上传地址。");
  const returnedHeaders = object(data.headers);
  const headers = {};
  for (const [name, value] of Object.entries(returnedHeaders)) {
    if (typeof value === "string" && value.trim()) headers[name] = value;
  }
  return {
    url: uploadURL,
    method: "PUT",
    headers,
    credentialless: true,
    bodyType: "file",
    fileRef: file.ref,
  };
}

export function buildSubmitRequest(ctx) {
  let requestBody = ctx.requestBody;
  const file = localImageFile(ctx);
  const source = file && uploadedAssetSource(ctx);
  if (file && !source) throw new Error("SDGO 本地图片素材上传未完成，未向上游提交内联真人图片。");
  if (file && source) requestBody = requestWithAssetImage(requestBody, file, source);
  const body = normalizeImplicitVideoEdit(payloadFor(requestBody, ctx.model, ctx.upstreamModel));
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
  return body.status !== undefined || body.id || body.task_id || body.error || body.message
    ? body
    : object(body.data);
}

function errorMessage(body) {
  const error = object(body.error);
  return first(error.message, typeof body.error === "string" ? body.error : "", body.message, "视频生成失败，请稍后重试。");
}

function resultURL(body) {
  return text(object(body.content).video_url);
}

export function parseSubmitResponse(ctx, response) {
  const body = taskBody(response.body);
  if (["failed", "cancelled", "expired"].includes(text(body.status).toLowerCase())) throw new Error(errorMessage(body));
  const id = first(body.id, body.task_id);
  if (!id) throw new Error("暂未获取到任务编号，无法确认提交结果，请联系管理员核查，勿重复提交。");
  return {
    taskId: id,
    taskData: response.body,
    state: { video_input: videoInputFor(ctx.requestBody) },
  };
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

export function parseTaskResult(_ctx, value, response) {
  const body = taskBody(value);
  const httpStatus = Number(object(response).status);
  if (httpStatus >= 400 && httpStatus < 500) {
    return { status: "FAILURE", progress: "100%", reason: errorMessage(body) };
  }
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
  const req = object(request);
  const cfg = modelConfig(first(req.model));
  const metadata = parseMetadata(req.metadata);
  const rawDuration = req.duration !== undefined
    ? req.duration
    : req.seconds !== undefined
      ? req.seconds
      : metadata.duration !== undefined
        ? metadata.duration
        : metadata.seconds;
  const seconds = Number(rawDuration);
  if (seconds === -1) return cfg.maxDuration === Number.MAX_SAFE_INTEGER ? DEFAULT_MAX_DURATION : cfg.maxDuration;
  if (Number.isInteger(seconds) && seconds >= (cfg.minDuration || 4)) return Math.min(seconds, cfg.maxDuration);
  return cfg.defaultDuration === -1
    ? (cfg.maxDuration === Number.MAX_SAFE_INTEGER ? DEFAULT_MAX_DURATION : cfg.maxDuration)
    : cfg.defaultDuration;
}

function resolutionFrom(value) {
  const resolution = text(object(value).resolution) || text(object(value).content && object(value).content.resolution);
  return RESOLUTIONS.includes(resolution.toLowerCase()) ? resolution.toLowerCase() : "";
}

function videoInputFor(value) {
  const request = object(value);
  if (asArray(request.videos).length > 0 || asArray(request.video_urls).length > 0) return "present";
  const content = Array.isArray(request.content) ? request.content : [];
  return content.some((item) => object(item).type === "video_url" || object(item).video_url) ? "present" : "none";
}

function videoInputFromState(value) {
  const state = object(value);
  const stateValue = text(state.video_input).toLowerCase();
  return VIDEO_INPUTS.includes(stateValue) ? stateValue : "";
}

export function extractUsage(ctx) {
  const request = object(ctx.requestBody);
  const model = first(ctx.upstreamModel, ctx.model, request.model);
  const cfg = modelConfig(model);
  const resolution = resolutionFrom(request) || cfg.defaultResolution;
  return {
    seconds: secondsFor(Object.assign({ model }, request)),
    resolution,
    video_input: videoInputFor(request),
  };
}

export function extractUsageOnComplete(task, _taskResult, body) {
  const value = taskBody(body);
  if (!["succeeded", "completed", "success", "done"].includes(text(value.status).toLowerCase())) return {};
  const facts = {};
  const duration = Number(value.duration);
  if (Number.isInteger(duration) && duration > 0) facts.seconds = duration;
  const resolution = resolutionFrom(value);
  if (resolution) facts.resolution = resolution;
  const videoInput = videoInputFromState(task.state) || text(value.video_input).toLowerCase();
  if (VIDEO_INPUTS.includes(videoInput)) facts.video_input = videoInput;
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
