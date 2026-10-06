// Seedream 5.0 Pro task plugin.
//
// This file is intentionally a single New API plugin source file. It does not
// expose the upstream name, URL, or credential in any public response.

const PUBLIC_MODEL = "doubao-seedream-5-0-pro";
const UPSTREAM_MODEL = "doubao-seedream-5-0-pro-260628";
const SUPPORTED_TIERS = ["1K", "2K"];
const MAX_2K_PIXELS = 2048 * 2048;
const MAX_REFERENCE_IMAGES = 14;

export const meta = {
  apiVersion: 1,
  key: "seedream-pro",
  name: "Seedream 5.0 Pro",
  description: {
    en: "Seedream 5.0 Pro image generation",
    zh: "Seedream 5.0 Pro 图片生成",
  },
  version: "1.1.8",
  author: { name: "88API" },
  models: [PUBLIC_MODEL],
  fetchMode: "per_task",
  upstreams: ["vendor"],
  protocols: [{ name: "openai_image", models: [PUBLIC_MODEL] }],
  usageSchema: {
    image_count: {
      type: "number",
      unit: "count",
      unitLabel: { en: "image", zh: "张" },
      description: { en: "Image generation unit price", zh: "图片生成单价" },
    },
    quality: {
      enum: SUPPORTED_TIERS,
      enumLabels: {
        "1K": { en: "1K", zh: "1K" },
        "2K": { en: "2K", zh: "2K" },
      },
      description: { en: "Upstream output tier", zh: "上游输出档位" },
    },
    size: {
      enum: SUPPORTED_TIERS,
      enumLabels: {
        "1K": { en: "1K", zh: "1K" },
        "2K": { en: "2K", zh: "2K" },
      },
      description: { en: "Normalized output tier", zh: "归一化输出档位" },
    },
  },
  usageExamples: [],
  auth: "api_key",
};

function record(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function string(value) {
  return typeof value === "string" ? value.trim() : "";
}

function integer(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) ? number : fallback;
}

function normalizeCount(value) {
  const count = integer(value, 1);
  if (count < 1 || count > 4) throw new Error("n 必须是 1 到 4 的整数。");
  return count;
}

function parseDimensions(value) {
  const match = /^(\d+)\s*[xX×*]\s*(\d+)$/.exec(string(value));
  if (!match) return null;
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0) return null;
  return { width, height };
}

function roundToStep(value, step = 16) {
  return Math.max(step, Math.floor(value / step) * step);
}

function fitTo2K(width, height) {
  const scale = Math.min(1, 2048 / Math.max(width, height), Math.sqrt(MAX_2K_PIXELS / (width * height)));
  return {
    width: roundToStep(width * scale),
    height: roundToStep(height * scale),
  };
}

function tierFromDimensions(dimensions) {
  // Canvas 1K requests are normally around 1024–1536 px on the long edge.
  // Everything larger is charged as 2K after normalization.
  return Math.max(dimensions.width, dimensions.height) <= 1536 ? "1K" : "2K";
}

function normalizeTier(value) {
  const raw = string(value).toLowerCase();
  if (!raw || raw === "auto" || raw === "low" || raw === "standard" || raw === "1k") return "1K";
  if (raw === "medium" || raw === "hd" || raw === "high" || raw === "2k" || raw === "4k") return "2K";
  throw new Error("quality 只支持 1K/2K；画布的 high/4K 请求会按上游可用的 2K 处理。");
}

function resolveImageSpec(request) {
  const rawSize = string(request.size);
  const rawQuality = request.quality === undefined ? "" : string(request.quality);
  const quality = rawQuality ? normalizeTier(rawQuality) : "";

  if (!rawSize) {
    const tier = quality || "1K";
    return { quality: tier, size: tier };
  }

  if (/^(1k|2k|4k)$/i.test(rawSize)) {
    const requestedTier = rawSize.toUpperCase() === "1K" ? "1K" : "2K";
    return { quality: quality === "2K" || requestedTier === "2K" ? "2K" : "1K", size: requestedTier };
  }

  const dimensions = parseDimensions(rawSize);
  if (!dimensions) throw new Error("size 必须是 1K、2K 或 WxH 尺寸。");

  const dimensionTier = tierFromDimensions(dimensions);
  const tier = quality === "2K" || dimensionTier === "2K" ? "2K" : "1K";
  const fitted = fitTo2K(dimensions.width, dimensions.height);
  const normalized = `${fitted.width}x${fitted.height}`;
  return { quality: tier, size: normalized };
}

function normalizeBackground(value) {
  const raw = string(value).toLowerCase();
  if (!raw || raw === "opaque") return "";
  if (raw === "transparent") {
    // The canvas sends its generic image default as transparent.  Seedream
    // does not support transparency, so omit the field and let the upstream
    // service use its opaque default instead of rejecting an otherwise valid
    // canvas request.
    return "";
  }
  throw new Error("background 只支持默认不传；当前上游不支持指定背景色。");
}

function isHttpUrl(value) {
  return /^https?:\/\//i.test(string(value));
}

function isFileReference(value) {
  return !!(value && typeof value === "object" && !Array.isArray(value) && string(value.__fileRef));
}

function normalizeImageValues(values) {
  const images = [];
  for (const value of values || []) {
    if (value && typeof value === "object" && value.__fileRef) {
      images.push(value);
      continue;
    }
    const url = string(value);
    if (!url) continue;
    if (!isHttpUrl(url)) {
      throw new Error("图生图参考图必须是公网可访问的 HTTP(S) URL。");
    }
    images.push(url);
  }
  if (images.length > MAX_REFERENCE_IMAGES) {
    throw new Error(`参考图最多支持 ${MAX_REFERENCE_IMAGES} 张。`);
  }
  return images;
}

function collectJsonImages(request) {
  const values = [];
  if (request.image !== undefined) values.push(request.image);
  if (request.images !== undefined) {
    if (!Array.isArray(request.images)) throw new Error("images 必须是字符串数组。");
    values.push(...request.images);
  }
  return normalizeImageValues(values);
}

function collectMultipartImages(ctx) {
  const body = ctx.body;
  const values = [];
  const imageFields = [
    ...(body.fields.image || []),
    ...(body.fields.images || []),
    ...(body.fields["image[]"] || []),
    ...(body.fields["images[]"] || []),
  ];
  values.push(...imageFields);
  for (const file of body.files || []) {
    if (!/^images?(?:\[\])?$/i.test(string(file.field))) continue;
    values.push({
      __fileRef: file.ref,
      encoding: "dataUrl",
      mimeType: file.mimeType || "image/png",
      maxBytes: 30 * 1024 * 1024,
    });
  }
  return normalizeImageValues(values);
}

function decodeFields(fields) {
  const request = {};
  for (const [name, values] of Object.entries(fields || {})) {
    if (!Array.isArray(values) || values.length === 0) continue;
    request[name] = values.length === 1 ? values[0] : [...values];
  }
  return request;
}

function decodeBody(ctx) {
  if (ctx.body.kind === "json") {
    const value = record(ctx.body.value);
    return { ...value, _images: collectJsonImages(value) };
  }
  if (ctx.body.kind === "form") {
    const value = decodeFields(ctx.body.fields);
    return { ...value, _images: collectJsonImages(value) };
  }
  if (ctx.body.kind === "multipart") {
    const value = decodeFields(ctx.body.fields);
    return { ...value, _images: collectMultipartImages(ctx) };
  }
  throw new Error("请使用 JSON、表单或 multipart 请求体调用 Seedream 图片接口。");
}

function moveProtocolUsageFields(request) {
  const clean = { ...request };
  if (Object.prototype.hasOwnProperty.call(clean, "quality")) {
    clean.__seedream_quality = clean.quality;
    delete clean.quality;
  }
  if (Object.prototype.hasOwnProperty.call(clean, "size")) {
    clean.__seedream_size = clean.size;
    delete clean.size;
  }
  return clean;
}

function cleanRequest(request, ctx) {
  const prompt = string(request.prompt);
  if (!prompt) throw new Error("prompt 不能为空。");
  if (request.mask !== undefined) throw new Error("Seedream 5.0 Pro 不支持 mask。");
  if (request.stream !== undefined && request.stream !== false && request.stream !== "false") {
    throw new Error("图片生成不支持 stream，完成后一次性返回结果。");
  }
  normalizeBackground(request.background);

  const normalizedRequest = {
    ...request,
    quality: request.__seedream_quality ?? request.quality,
    size: request.__seedream_size ?? request.size,
  };
  const spec = resolveImageSpec(normalizedRequest);
  const images = request._images || collectJsonImages(request);
  const count = normalizeCount(request.n);
  const model = string(ctx.upstreamModel) && ctx.upstreamModel !== PUBLIC_MODEL ? ctx.upstreamModel : UPSTREAM_MODEL;
  const body = {
    model,
    prompt,
    n: count,
    quality: spec.quality,
    response_format: request.response_format === "b64_json" ? "b64_json" : "url",
    size: spec.size,
  };

  if (images.length === 1) body.image = images[0];
  if (images.length > 1) body.images = images;

  return { body, images, quality: spec.quality };
}

function upstreamPath(baseUrl, path) {
  let base = string(baseUrl).replace(/\/+$/, "");
  // XinMeng documents two valid third-party bases: the host root and the
  // OpenAI-compatible `/v1` base. Be defensive about an old saved value that
  // already contains a duplicated trailing `/v1`; never create another one.
  base = base.replace(/\/v1\/v1$/i, "/v1");
  if (/\/v1$/i.test(base)) return `${base}${path}`;
  return `${base}/v1${path}`;
}

function imageEntries(body) {
  const value = record(body);
  const data = Array.isArray(value.data)
    ? value.data
    : Array.isArray(value.images)
      ? value.images
      : Array.isArray(value.results)
        ? value.results
        : [];
  return data.filter((item) => item && typeof item === "object" && !Array.isArray(item));
}

function imagePayloads(body) {
  return imageEntries(body).filter((item) => string(item.url) || string(item.b64_json));
}

function responseEntries(body) {
  const payloads = imagePayloads(body);
  if (!payloads.length) throw new Error("上游图片服务未返回图片结果。");
  return payloads.map((item) => {
    const result = {};
    if (string(item.url)) result.url = string(item.url);
    if (string(item.b64_json)) result.b64_json = string(item.b64_json);
    if (string(item.revised_prompt)) result.revised_prompt = string(item.revised_prompt);
    return result;
  });
}

function upstreamError(body, statusCode, ctx = {}) {
  const value = record(body);
  const error = record(value.error);
  const message = string(error.message) || string(value.message) || string(value.msg);
  if (message) {
    const baseUrl = string(ctx.baseUrl);
    const sanitized = message
      .replace(/https?:\/\/\S+/gi, "[upstream]")
      .replaceAll(UPSTREAM_MODEL, PUBLIC_MODEL);
    return baseUrl ? sanitized.replaceAll(baseUrl, "[upstream]") : sanitized;
  }
  if (statusCode >= 400) return "上游图片服务请求失败，请稍后重试。";
  return "";
}

export function buildSubmitRequest(ctx) {
  const normalized = cleanRequest(record(ctx.requestBody), ctx);
  const fileImages = normalized.images.filter(isFileReference);
  if (fileImages.length) {
    if (fileImages.length !== 1 || normalized.images.length !== 1) {
      throw new Error("Seedream 5.0 Pro 当前仅支持画布单张参考图；多张本地参考图暂不可用。");
    }
    // XinMeng documents image-to-image on the same `/v1/images/generations`
    // endpoint. JSON placeholders let the host inline the original canvas
    // upload as a data URL without exposing file bytes to the plugin or
    // leaking the upstream channel details.
    const body = { ...normalized.body };
    body.image = {
      ...fileImages[0],
      encoding: "dataUrl",
      mimeType: fileImages[0].mimeType || "image/png",
      maxBytes: 30 * 1024 * 1024,
    };
    return {
      url: upstreamPath(ctx.baseUrl, "/images/generations"),
      method: "POST",
      headers: {
        Authorization: `Bearer ${ctx.apiKey || ""}`,
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body,
      bodyType: "json",
      rewriteModel: normalized.body.model,
      action: "image_to_image",
    };
  }
  return {
    url: upstreamPath(ctx.baseUrl, "/images/generations"),
    method: "POST",
    headers: {
      Authorization: `Bearer ${ctx.apiKey || ""}`,
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: normalized.body,
    bodyType: "json",
    rewriteModel: normalized.body.model,
    action: normalized.images.length ? "image_to_image" : "text_to_image",
  };
}

export function parseSubmitResponse(ctx, response) {
  const message = upstreamError(response.body, response.statusCode, ctx);
  if (message) throw new Error(message);
  const normalized = cleanRequest(record(ctx.requestBody), ctx);
  const entries = responseEntries(response.body);
  return {
    taskId: string(ctx.publicTaskId),
    taskData: { data: entries, quality: normalized.quality },
    immediate: { status: "SUCCESS", progress: "100%" },
    state: { quality: normalized.quality },
  };
}

// The image protocol is synchronous: parseSubmitResponse returns an immediate
// terminal result, so the host never needs to poll this plugin. New API still
// requires every task plugin to export the polling parser; return UNKNOWN
// rather than pretending an unrecognized response is still in progress.
export function parseTaskResult(ctx, body, response) {
  const message = upstreamError(body, response && response.statusCode, ctx);
  if (message) return { status: "FAILURE", progress: "100%", reason: message };
  if (imagePayloads(body).length) {
    return { status: "SUCCESS", progress: "100%", state: { phase: "completed" } };
  }
  return { status: "UNKNOWN", reason: "上游图片服务未返回图片结果。" };
}

// This adapter completes on the submit response. The per_task hook is still
// required by the plugin contract; it is only a defensive fallback for a host
// that decides to poll a persisted task.
export function buildQueryRequest(ctx) {
  const taskId = string(ctx.taskId);
  const state = record(ctx.state);
    if (state.phase === "generate" && record(state.body).prompt) {
    return {
      url: upstreamPath(ctx.baseUrl, "/images/generations"),
      method: "POST",
      headers: {
        Authorization: ctx.authHeader || `Bearer ${ctx.apiKey || ""}`,
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: state.body,
      bodyType: "json",
      action: "image_to_image",
    };
  }
  return {
    url: upstreamPath(ctx.baseUrl, `/images/generations/${encodeURIComponent(taskId)}`),
    method: "GET",
    headers: {
      Authorization: ctx.authHeader || `Bearer ${ctx.apiKey || ""}`,
      Accept: "application/json",
    },
  };
}

function usageFacts(quality, count) {
  return {
    image_count: count,
    quality,
    size: quality,
  };
}

export function extractUsage(ctx) {
  const normalized = cleanRequest(record(ctx.requestBody), ctx);
  return usageFacts(normalized.quality, normalizeCount(record(ctx.requestBody).n));
}

export function extractUsageOnSubmit(ctx, taskData) {
  const normalized = cleanRequest(record(ctx.requestBody), ctx);
  const count = imagePayloads(taskData).length || normalizeCount(record(ctx.requestBody).n);
  return usageFacts(normalized.quality, count);
}

export function extractUsageOnComplete(task, _result, data) {
  const count = imagePayloads(data).length;
  if (!count) return null;
  const quality = string(record(task.state).quality) || string(record(task.data).quality) || "1K";
  return usageFacts(quality, count);
}

export const protocols = {
  openai_image: {
    decodeRequest(ctx) {
      const request = decodeBody(ctx);
      const { _images: images } = request;
      const clean = moveProtocolUsageFields(request);
      delete clean._images;
      if (images.length === 1) clean.image = images[0];
      if (images.length > 1) clean.images = images;
      if (images.length === 0) {
        delete clean.image;
        delete clean.images;
      }
      return {
        kind: "submit",
        model: PUBLIC_MODEL,
        action: images.length ? "image_to_image" : "text_to_image",
        requestBody: clean,
      };
    },
    render(_ctx, task) {
      return {
        created: task.created_at,
        data: responseEntries(task.data),
      };
    },
  },
};
