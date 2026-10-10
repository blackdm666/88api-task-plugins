import assert from "node:assert/strict";
import test from "node:test";
import * as plugin from "../plugins/vertex-omni/plugin.js";

const model = "gemini-omni-flash-1.1";
const flashModel = "gemini-omni-flash";
const veoModel = "veo-3.1";
const veoFastModel = "veo-3.1-fast";
const upstream = "gemini-omni-1.1-flash-preview";
const bucket = "88api-omni-media";
const outputPrefix = "gs://" + bucket + "/vertex-omni/task_fixture01/";
const delivery = { delivery: "uri", gcs_uri: outputPrefix };
const stored = outputPrefix + "123.mp4";
const clip = "https://cdn.example.com/clip.mp4";
const still = "https://cdn.example.com/still.png";
function decode(value = {}, name = model) {
  return plugin.protocols.openai_video.decodeRequest({
    model: name, body: { kind: "json", value: { prompt: "Fixture", ...value } },
  });
}
function driver(value = {}, name = model, upstreamName = upstream) {
  return { model: name, upstreamModel: upstreamName, baseUrl: "https://aiplatform.googleapis.com",
    authHeader: "Bearer fixture-token", auth: { projectId: "fixture-project" }, publicTaskId: "task_fixture01",
    requestBody: decode(value, name).requestBody };
}
// Simulate the Worker's preflight answer for exactly what the plugin asked.
function ingested(ctx, facts = { seconds: 10, resolution: "720p" }, edit = items => items) {
  const preflight = plugin.buildPreflightRequest(ctx);
  assert.ok(preflight, "media requests always preflight");
  const items = preflight.body.items.map((item, index) => ({
    url: item.url, kind: item.kind, size: 1234,
    uri: "gs://" + bucket + "/vertex-omni-inputs/2026-10-09/" + index + (item.kind === "video" ? ".mp4" : ".png"),
    mime_type: item.kind === "video" ? "video/mp4" : item.url.endsWith(".jpg") ? "image/jpeg" : "image/png",
    ...(item.kind === "video" && preflight.body.measure && facts !== null ? { facts } : {}),
  }));
  return { ...ctx, preflightResponse: { status: 200, body: { object: "gcs_ingest", items: edit(items) } } };
}
function probe(facts = { seconds: 20.032, resolution: "720p" }, uri = stored) {
  return { object: "gcs_probe", id: "v1_fixture", status: "completed",
    outputs: [{ type: "video", mime_type: "video/mp4", uri }], facts };
}
function completed(part = { type: "video", mime_type: "video/mp4", data: "dmlkZW8=" }) {
  return { id: "v1_fixture", status: "completed", steps: [{ type: "model_output", content: [part] }] };
}
function mp4(seconds, resolution = "720p", version = 0, movieSeconds = seconds) {
  const atom = (type, ...parts) => {
    const body = Buffer.concat(parts), header = Buffer.alloc(8);
    header.writeUInt32BE(body.length + 8); header.write(type, 4);
    return Buffer.concat([header, body]);
  };
  const mdhd = Buffer.alloc(version ? 32 : 24);
  mdhd[0] = version;
  const time = version ? 20 : 12;
  mdhd.writeUInt32BE(1000, time);
  if (version) mdhd.writeBigUInt64BE(BigInt(seconds * 1000), time + 4);
  else mdhd.writeUInt32BE(seconds * 1000, time + 4);
  const movie = Buffer.from(mdhd);
  if (version) movie.writeBigUInt64BE(BigInt(Math.round(movieSeconds * 1000)), time + 4);
  else movie.writeUInt32BE(Math.round(movieSeconds * 1000), time + 4);
  const hdlr = Buffer.alloc(24); hdlr.write("vide", 8);
  const tkhd = Buffer.alloc(84);
  const [width, height] = { "360p": [640, 360], "720p": [1280, 720], "1080p": [1920, 1080], "4k": [3840, 2160] }[resolution];
  tkhd.writeUInt32BE(width * 65536, 76); tkhd.writeUInt32BE(height * 65536, 80);
  return Buffer.concat([
    atom("ftyp", Buffer.from("isom0000")),
    // mdat is deliberately not interpreted, even with fake metadata markers.
    atom("mdat", Buffer.from("fake-mvhd-mdhd-never-read")),
    atom("moov", atom("mvhd", movie), atom("trak", atom("tkhd", tkhd), atom("mdia", atom("mdhd", mdhd), atom("hdlr", hdlr)))),
  ]).toString("base64");
}

test("manifest claims exactly the four public names, never type 41, upstream IDs or Lite", () => {
  assert.equal(plugin.meta.key, "vertex-omni");
  assert.equal(plugin.meta.version, "1.7.0");
  assert.deepEqual(plugin.meta.requiredCapabilities, ["task-preflight@1"], "no SSE host capability");
  assert.deepEqual(plugin.meta.allowedHosts, ["storage.googleapis.com", "us-central1-aiplatform.googleapis.com", "assets.88api.ai"]);
  assert.deepEqual([...plugin.meta.models].sort(), [model, flashModel, veoModel, veoFastModel].sort());
  assert.equal(plugin.meta.channelTypes, undefined);
  assert.equal(plugin.meta.dynamicModels, undefined);
  assert.deepEqual(plugin.meta.auth, { type: "oauth2_jwt" });
  for (const name of [upstream, "gemini-omni-flash-preview", "veo-3.1-generate-001", "veo-3.1-fast-generate-001",
    "veo-3.1-lite-generate-001", "veo-3.1-lite", "veo-3.0-generate-001",
    "vertex-omni-1.1-test", "vertex-omni-flash-test", "vertex-veo-3.1-test", "vertex-veo-3.1-fast-test"]) {
    assert.throws(() => plugin.protocols.openai_video.decodeRequest({
      model: name, body: { kind: "json", value: { prompt: "Fixture" } },
    }), /不支持该模型/);
  }
});

test("pricing enum lists only the resolutions each model accepts", () => {
  const enumFor = name => (plugin.meta.usageProfiles.find(p => p.models.includes(name))?.schema ?? plugin.meta.usageSchema).resolution.enum;
  assert.deepEqual(enumFor(flashModel), ["720p"]);
  for (const name of [model, veoModel, veoFastModel]) assert.deepEqual(enumFor(name), ["720p", "1080p", "4k"], name);
  assert.deepEqual(plugin.meta.usageProfiles.map(p => p.models), [[flashModel]]);
  const flash = plugin.meta.usageProfiles[0].schema;
  assert.deepEqual(Object.keys(flash).sort(), Object.keys(plugin.meta.usageSchema).sort(), "only the enum narrows");
  // The narrowed enum still covers every value Omni Flash can bill.
  for (const resolution of ["360p", "720p"]) {
    assert.equal(plugin.extractUsage(driver({ duration: 4, resolution }, flashModel, "gemini-omni-flash-preview")).resolution, "720p");
  }
  for (const resolution of ["1080p", "4k"]) {
    assert.throws(() => decode({ duration: 4, resolution }, flashModel), /输出分辨率仅支持 720p/);
  }
});

test("bounded usage and Interactions wire agree, including all supported duration aliases", () => {
  for (const value of [{ duration: 3 }, { seconds: "10" }, { metadata: { duration_seconds: 4 } },
    { metadata: { durationSeconds: 6 } }]) {
    const ctx = driver({ ...value, size: "720x1280" });
    assert.equal(plugin.buildPreflightRequest(ctx), null, "text-only requests skip the ingest preflight");
    const request = plugin.buildSubmitRequest(ctx);
    assert.equal(request.url, "https://aiplatform.googleapis.com/v1beta1/projects/fixture-project/locations/global/interactions");
    assert.equal(request.headers.Authorization, "Bearer fixture-token");
    assert.equal(request.headers["x-goog-user-project"], "fixture-project");
    assert.equal(request.headers["Api-Revision"], undefined);
    assert.equal(request.method, "POST");
    assert.equal(request.body.model, upstream);
    assert.equal(request.body.background, true);
    assert.equal(request.body.store, true);
    assert.equal(request.body.stream, false);
    assert.equal(request.body.generation_config.video_config.task, "text_to_video");
    assert.deepEqual(request.body.input, [{ type: "user_input", content: [{ type: "text", text: "Fixture" }] }]);
    const usage = plugin.extractUsage(ctx);
    assert.deepEqual(request.body.response_format, [{
      type: "video", aspect_ratio: "9:16", resolution: "720p", duration: String(usage.seconds) + "s", ...delivery,
    }]);
    assert.equal(usage.resolution, "720p");
  }
  const unmapped = driver();
  unmapped.upstreamModel = model;
  assert.equal(plugin.buildSubmitRequest(unmapped).body.model, upstream);
  unmapped.upstreamModel = "veo-3.1";
  assert.throws(() => plugin.buildSubmitRequest(unmapped), /精确上游型号/);
});

test("invalid billing multipliers, conflicting aliases and hidden wire overrides fail before submit", () => {
  for (const duration of [0, -1, 2, 11, 3.5, null, false, "", "3.0", "Infinity", 1e100]) {
    assert.throws(() => decode({ duration }), /时长/);
  }
  for (const value of [
    { duration: 3, seconds: 4 }, { duration: 3, metadata: { durationSeconds: 8 } },
    { size: "720x1280", aspect_ratio: "16:9" }, { size: "1280x1280" },
    { n: 2 }, { n: null }, { metadata: { candidate_count: 3 } }, { resolution: "8k" },
    { response_format: [] }, { generation_config: {} },
    { background: false }, { store: false }, { stream: true }, { model: "veo-3.1" },
    { task: "unknown" }, { audios: ["https://cdn.example.com/a.mp3"] },
    { metadata: { output_gcs_uri: "gs://fixture-bucket/out/" } },
  ]) assert.throws(() => decode(value));
  for (const value of [{ duration: 11 }, { duration: 4, seconds: 3 }, { n: 100 }]) {
    assert.throws(() => plugin.extractUsage({ model, requestBody: { prompt: "Fixture", ...value } }));
    assert.throws(() => plugin.buildSubmitRequest({ ...driver(), requestBody: { prompt: "Fixture", ...value } }));
  }
});

test("videos are HTTP(S) only; images also accept Data URI, raw Base64 and multipart files", () => {
  for (const url of [clip, "http://cdn.example.com/a.mp4", "https://cdn.example.com/a.mp4?sig=x&t=1",
    "https://cdn.example.com:8443/path/a%20b.mp4#frag"]) assert.equal(decode({ video: url }).action, "edit");
  for (const value of [
    { video: "data:video/mp4;base64,dmlkZW8=" }, { video: "dmlkZW8=" }, { video: { __fileRef: "request_file:video", mimeType: "video/mp4" } },
    { image: "gs://fixture-bucket/image.webp" }, { video: "ftp://cdn.example.com/a.mp4" },
    { image: "https://user:pass@cdn.example.com/a.png" }, { image: "https://cdn.example.com/a b.png" },
    { image: "https:///a.png" }, { image: "https://cdn.example.com/" + "a".repeat(4100) }, { image: { uri: still } },
    { image: { __fileRef: "malicious", mimeType: "image/png" } }, { image: "data:image/svg+xml;base64,eA==" },
    { image: "data:image/png;base64,%%%" }, { image: "R0lGODlhAQABAIAAAP///wAAACw=" }, { image: "not base64 at all" },
    { images: "not-array" }, { videos: Array(4).fill(clip) }, { images: Array(11).fill(still) },
    { metadata: { previous_interaction_id: "../bad" } },
  ]) assert.throws(() => decode(value), undefined, JSON.stringify(value).slice(0, 80));
  assert.throws(() => decode({ video: "data:video/mp4;base64,dmlkZW8=" }), /视频仅接受 HTTP\(S\) 链接/);
  assert.throws(() => decode({ image: "data:image/gif;base64,R0lGODlh" }), /image\/gif 不受支持/);
  const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGBgAAAABQABpfZFQAAAAABJRU5ErkJggg==";
  assert.deepEqual(plugin.buildPreflightRequest(driver({ images: ["data:image/jpeg;base64,/9j/4AAQ", png, still] })).body.items,
    [{ url: still, kind: "image" }], "only links are ingested");
  assert.throws(() => plugin.buildSubmitRequest(driver({ images: ["data:image/jpeg;base64,/9j/4AAQ", png, still] })), /未返回有效结果/);
  const ok = plugin.buildSubmitRequest(ingested(driver({ images: ["data:image/jpeg;base64,/9j/4AAQ", png, still] })));
  assert.deepEqual(ok.body.input[0].content.slice(0, 3), [
    { type: "image", mime_type: "image/jpeg", data: "/9j/4AAQ" },
    { type: "image", mime_type: "image/png", data: png },
    { type: "image", mime_type: "image/png", uri: "gs://" + bucket + "/vertex-omni-inputs/2026-10-09/0.png" },
  ]);
  assert.equal(plugin.buildPreflightRequest(driver({ image: png })), null, "inline images need no preflight");
  assert.throws(() => decode({ metadata: { output_gcs_uri: "gs://fixture-bucket/out/" } }), /由平台管理/);
});

test("multipart accepts image files (inlined by the host) and rejects video files", () => {
  const body = { kind: "multipart", fields: { prompt: ["Fixture"], seconds: ["6"], metadata: ['{"resolution":"1080p"}'] },
    files: [{ ref: "request_file:input_reference", field: "input_reference", size: 4, mimeType: "image/png" }] };
  const decoded = plugin.protocols.openai_video.decodeRequest({ model: veoModel, body });
  assert.equal(decoded.action, "image_to_video");
  const request = plugin.buildSubmitRequest({ ...driver({}, veoModel, veoModel), requestBody: decoded.requestBody });
  assert.deepEqual(request.body.instances[0].image, { bytesBase64Encoded: { __fileRef: "request_file:input_reference",
    encoding: "base64", mimeType: "image/png", maxBytes: 20 * 1024 * 1024 }, mimeType: "image/png" });
  assert.equal(request.body.parameters.durationSeconds, 6);
  assert.equal(request.body.parameters.resolution, "1080p");
  const omni = plugin.protocols.openai_video.decodeRequest({ model, body: { ...body, fields: { prompt: ["Fixture"] } } });
  assert.equal(omni.action, "image_to_video", "a single uploaded image is the first frame");
  const sniffed = plugin.protocols.openai_video.decodeRequest({ model: veoModel, body: { ...body,
    files: [{ ref: "request_file:images[]", field: "images[]", filename: "a.JPG", size: 4, mimeType: "application/octet-stream" }] } });
  assert.deepEqual(sniffed.requestBody.images, [{ __fileRef: "request_file:images[]", mimeType: "image/jpeg" }]);
  for (const invalid of [
    { ...body, files: [{ ref: "request_file:video", field: "video", size: 4, mimeType: "video/mp4" }] },
    { ...body, files: [{ ref: "request_file:image", field: "image", filename: "a.bin", size: 4, mimeType: "" }] },
    { ...body, files: [{ ref: "request_file:image", field: "image", size: 20 * 1024 * 1024 + 1, mimeType: "image/png" }] },
    { ...body, fields: { ...body.fields, seconds: ["4", "6"] } }, { ...body, fields: { ...body.fields, metadata: ["not-json"] } },
  ]) assert.throws(() => plugin.protocols.openai_video.decodeRequest({ model: veoModel, body: invalid }));
  assert.throws(() => plugin.protocols.openai_video.decodeRequest({ model: veoModel, body: { ...body,
    files: [{ ref: "request_file:image", field: "image", size: 4, mimeType: "image/webp" }] } }), /image\/webp 不受支持/);
});

test("old type-41 request shapes keep their meaning on the public names", () => {
  // Omni: one image without a task is the first frame; several are references.
  const single = plugin.buildSubmitRequest(ingested(driver({ image: still }, "gemini-omni-flash", "gemini-omni-flash")));
  assert.equal(single.body.generation_config.video_config.task, "image_to_video");
  assert.match(single.body.input[0].content.at(-1).text, /Use the image as the first frame\.$/);
  assert.equal(plugin.buildSubmitRequest(ingested(driver({ images: [still, still] }, "gemini-omni-flash-1.1",
    "gemini-omni-flash-1.1"))).body.generation_config.video_config.task, "reference_to_video");
  assert.equal(plugin.buildSubmitRequest(ingested(driver({ image: still, task: "reference_to_video" }))).body
    .generation_config.video_config.task, "reference_to_video", "explicit task wins");
  // Veo: metadata.video_mode, and two images default to first+last frames.
  const frames = plugin.buildSubmitRequest(ingested(driver({ images: [still, "https://cdn.example.com/b.jpg"], duration: 4 },
    "veo-3.1-fast", "veo-3.1-fast")));
  assert.equal(frames.action, "image_to_video");
  assert.ok(frames.body.instances[0].image && frames.body.instances[0].lastFrame);
  const refs = plugin.buildSubmitRequest(ingested(driver({ images: [still, still], metadata: { video_mode: "reference" } },
    "veo-3.1", "veo-3.1")));
  assert.equal(refs.action, "reference_to_video");
  assert.equal(refs.body.instances[0].referenceImages.length, 2);
  assert.throws(() => decode({ images: [still], metadata: { video_mode: "story" } }, "veo-3.1"), /frames 或 reference/);
  assert.throws(() => decode({ images: [still], task: "text_to_video", metadata: { video_mode: "frames" } }, "veo-3.1"), /冲突/);
  const b64 = plugin.buildSubmitRequest(driver({ image: "data:image/jpeg;base64,/9j/4AAQ" }, "veo-3.1", "veo-3.1"));
  assert.deepEqual(b64.body.instances[0].image, { bytesBase64Encoded: "/9j/4AAQ", mimeType: "image/jpeg" });
  assert.throws(() => decode({ image: "data:image/webp;base64,UklGRiQAAABXRUJQ" }, "veo-3.1"), /image\/webp 不受支持/);
  // Public names share the QA specs, prices and upstreams.
  for (const [name, upstreamName] of [["veo-3.1", "veo-3.1-generate-001"], ["veo-3.1-fast", "veo-3.1-fast-generate-001"]]) {
    assert.match(plugin.buildSubmitRequest(driver({}, name, name)).url, new RegExp(upstreamName + ":predictLongRunning$"));
    assert.match(plugin.buildSubmitRequest(driver({}, name, upstreamName)).url, new RegExp(upstreamName + ":predictLongRunning$"));
  }
  assert.equal(plugin.buildSubmitRequest(driver({}, "gemini-omni-flash", "gemini-omni-flash")).body.model, "gemini-omni-flash-preview");
  assert.equal(plugin.buildSubmitRequest(driver({ resolution: "4k" }, "gemini-omni-flash-1.1", "gemini-omni-flash-1.1")).body.model,
    "gemini-omni-1.1-flash-preview");
  assert.throws(() => decode({ resolution: "1080p" }, "gemini-omni-flash"), /仅支持 720p/);
});

test("preflight ingests every URL in content order; the channel token is never a header", () => {
  const ctx = driver({ video: clip, images: [still, "https://cdn.example.com/b.webp"],
    metadata: { previous_interaction_id: "v1_previous" } });
  const preflight = plugin.buildPreflightRequest(ctx);
  assert.equal(preflight.url, "https://assets.88api.ai/gcs/ingest");
  assert.equal(preflight.method, "POST");
  assert.deepEqual(preflight.headers, { "Content-Type": "application/json", Accept: "application/json" });
  assert.deepEqual(preflight.body, { authorization: "Bearer fixture-token", bucket, measure: false, items: [
    { url: clip, kind: "video" }, { url: still, kind: "image" }, { url: "https://cdn.example.com/b.webp", kind: "image" },
  ] });
  const request = plugin.buildSubmitRequest(ingested(ctx));
  assert.equal(request.action, "reference_to_video");
  assert.deepEqual(request.body.input[0].content, [
    { type: "video", mime_type: "video/mp4", uri: "gs://" + bucket + "/vertex-omni-inputs/2026-10-09/0.mp4" },
    { type: "image", mime_type: "image/png", uri: "gs://" + bucket + "/vertex-omni-inputs/2026-10-09/1.png" },
    { type: "image", mime_type: "image/png", uri: "gs://" + bucket + "/vertex-omni-inputs/2026-10-09/2.png" },
    { type: "text", text: "Fixture" },
  ]);
  assert.equal(request.body.previous_interaction_id, "v1_previous");
  assert.equal(request.body.generation_config, undefined, "continuation inherits its mode");
  assert.ok(!JSON.stringify(request.body).includes("cdn.example.com"), "Google only receives gs:// URIs");
});

test("inconsistent or failed ingest answers stop the request before Google is called", () => {
  const ctx = driver({ images: [still, "https://cdn.example.com/b.png"] });
  for (const [label, broken, message] of [
    ["no preflight", { ...ctx }, /未返回有效结果/],
    ["worker error", { ...ctx, preflightResponse: { body: { object: "gcs_ingest", error: { code: "source_too_large", message: "image exceeds 20MiB" } } } }, /source_too_large/],
    ["count", ingested(ctx, undefined, items => items.slice(1)), /数量/],
    ["order", ingested(ctx, undefined, items => items.reverse()), /不一致/],
    ["kind", ingested(ctx, undefined, items => items.map(item => ({ ...item, kind: "video" }))), /不一致/],
    ["mime", ingested(ctx, undefined, items => items.map(item => ({ ...item, mime_type: "image/svg+xml" }))), /不受支持/],
    ["foreign bucket", ingested(ctx, undefined, items => items.map(item => ({ ...item, uri: "gs://elsewhere/a.png" }))), /不一致/],
    ["not gcs", ingested(ctx, undefined, items => items.map(item => ({ ...item, uri: still }))), /gs:\/\//],
  ]) assert.throws(() => plugin.buildSubmitRequest(broken), message, label);
});

test("official Omni modes, sampling, frame roles and extension wire are explicit", () => {
  const highQuality = plugin.buildSubmitRequest(driver({ duration: 10, resolution: "4k", temperature: 0.4, top_p: 0.8 }));
  assert.equal(highQuality.body.response_format[0].resolution, "4k");
  assert.deepEqual(highQuality.body.generation_config, { video_config: { task: "text_to_video" }, temperature: 0.4, top_p: 0.8 });
  assert.deepEqual(plugin.extractUsage(driver({ duration: 10, resolution: "4k" })), { seconds: 10, resolution: "4k" });

  const reference = plugin.buildSubmitRequest(ingested(driver({ task: "reference_to_video", videos: [clip, clip, clip] })));
  assert.equal(reference.body.input[0].content.filter(part => part.type === "video").length, 3);
  assert.equal(reference.body.generation_config.video_config.task, "reference_to_video");

  const frames = plugin.buildSubmitRequest(ingested(driver({ task: "image_to_video", first_frame: still,
    last_frame: "https://cdn.example.com/last.png" })));
  assert.deepEqual(frames.body.input[0].content.slice(0, 2).map(part => part.uri.split("/").pop()), ["0.png", "1.png"]);
  assert.ok(frames.body.input[0].content.every(part => part.role === undefined));
  assert.match(frames.body.input[0].content[2].text, /first image.*first frame.*second image.*last frame/);

  const edit = plugin.buildSubmitRequest(ingested(driver({ task: "edit", video: clip, duration: 3 })));
  assert.deepEqual(edit.body.response_format, [{ type: "video", ...delivery }]);
  assert.equal(edit.body.generation_config.video_config.task, "edit");
  const editHD = plugin.buildSubmitRequest(ingested(driver({ task: "edit", video: clip, resolution: "1080p" })));
  assert.deepEqual(editHD.body.response_format, [{ type: "video", resolution: "1080p", ...delivery }]);

  const extend = driver({ task: "extend", video: clip, input_duration: 10 });
  assert.equal(plugin.buildPreflightRequest(extend).body.measure, true, "extensions measure their input");
  const extension = plugin.buildSubmitRequest(ingested(extend));
  assert.deepEqual(extension.body.response_format, [{ type: "video", ...delivery }]);
  assert.equal(extension.body.generation_config.video_config.task, "extend");
  assert.deepEqual(plugin.extractUsage(extend), { seconds: 11, resolution: "720p" });
  const extendHD = driver({ task: "extend", video: clip, resolution: "1080p" });
  assert.deepEqual(plugin.buildSubmitRequest(ingested(extendHD)).body.response_format,
    [{ type: "video", resolution: "1080p", ...delivery }]);
  assert.deepEqual(plugin.extractUsage(extendHD), { seconds: 11, resolution: "1080p" });
});

test("extension requests and measured inputs are bounded to what Google accepts", () => {
  const base = { task: "extend", video: clip };
  for (const [value, message] of [
    [{ ...base, resolution: "4k" }, /720p 或 1080p/],
    [{ ...base, duration: 20 }, /固定新增/], [{ ...base, metadata: { durationSeconds: 40 } }, /固定新增/],
    [{ ...base, size: "1280x720" }, /沿用输入画面/], [{ ...base, aspect_ratio: "16:9" }, /沿用输入画面/],
    [{ ...base, video: undefined }, /1 个参考视频/], [{ ...base, input_duration: 31 }, /1 到 30/],
  ]) assert.throws(() => decode(value), message);
  for (const [facts, message] of [[null, /可测量时长/], [{ seconds: "10" }, /可测量时长/],
    [{ seconds: 0.5 }, /1 到 30/], [{ seconds: 31 }, /截取末尾/]]) {
    assert.throws(() => plugin.buildSubmitRequest(ingested(driver(base), facts)), message);
  }
  assert.throws(() => plugin.buildSubmitRequest(ingested(driver({ ...base, input_duration: 9 }), { seconds: 10 })), /不一致/);
  assert.equal(plugin.buildSubmitRequest(ingested(driver(base), { seconds: 30.037 })).action, "extend");
});

test("new extensions settle measured output minus measured input via the Worker probe", () => {
  const ctx = ingested(driver({ task: "extend", video: clip, resolution: "1080p" }), { seconds: 10, resolution: "4k" });
  const submitted = plugin.parseSubmitResponse(ctx, { body: { id: "v1_fixture", status: "in_progress" } });
  assert.deepEqual(submitted.state, { seconds: 11, resolution: "1080p", aspect_ratio: "16:9", input_seconds: 10,
    bill_added_seconds: true, task: "extend" });
  const query = { ...driver(), taskId: "v1_fixture", action: "extend", state: submitted.state, requestBody: undefined };
  const done = completed({ type: "video", mime_type: "video/mp4", uri: stored });
  done.usage = { total_output_tokens: 86880 };
  const waiting = plugin.parseTaskResult(query, done);
  assert.equal(waiting.status, "IN_PROGRESS");
  assert.equal(waiting.progress, "95%");
  assert.equal(waiting.state.probe_uri, stored);
  const probing = { ...query, state: waiting.state };
  const request = plugin.buildQueryRequest(probing);
  assert.equal(request.url, "https://assets.88api.ai/gcs/probe?id=v1_fixture&uri=" + encodeURIComponent(stored));
  assert.equal(request.method, "GET");
  assert.deepEqual(request.headers, { Accept: "application/json" }, "Google OAuth is not sent to the probe");
  const body = probe({ seconds: 20.032, resolution: "1080p", width: 1920, height: 1080 });
  body.duration = 999; body.usage = { total_output_tokens: 1 };
  const result = plugin.parseTaskResult(probing, body);
  assert.equal(result.status, "SUCCESS");
  assert.equal(result.url, "https://storage.googleapis.com/storage/v1/b/" + bucket + "/o/" +
    encodeURIComponent("vertex-omni/task_fixture01/123.mp4") + "?alt=media");
  assert.equal(result.state.output_seconds, 20.032);
  assert.deepEqual(plugin.extractUsageOnComplete(probing, result, body), { seconds: 10.032, resolution: "1080p" });
  assert.deepEqual(plugin.listArtifacts({ status: "SUCCESS", data: body }), [{ key: "video", type: "video", mimeType: "video/mp4" }]);
  // Inline completion (should Google ignore URI delivery) settles the same way.
  const inline = completed({ type: "video", mime_type: "video/mp4", data: mp4(20, "720p", 0, 20.032) });
  const inlineResult = plugin.parseTaskResult(query, inline);
  assert.equal(inlineResult.status, "SUCCESS");
  assert.deepEqual(plugin.extractUsageOnComplete(query, inlineResult, inline), { seconds: 10.032, resolution: "720p" });
  const immediate = plugin.parseSubmitResponse(ctx, { body: inline });
  assert.deepEqual(plugin.extractUsageOnComplete({ action: "extend", state: immediate.state },
    immediate.immediate, immediate.taskData), { seconds: 10.032, resolution: "720p" });
});

test("probe answers fail closed without refunding or settling estimates", () => {
  const state = { seconds: 11, task: "extend", bill_added_seconds: true, input_seconds: 10, probe_uri: stored };
  const query = { taskId: "v1_fixture", action: "extend", state };
  for (const body of [
    { ...probe(), error: { code: "gcs_unavailable", message: "upstream 503" } },
    probe({ seconds: 20, resolution: "720p" }, outputPrefix + "other.mp4"),
    probe({ seconds: 0, resolution: "720p" }), probe({ seconds: 42, resolution: "720p" }),
    probe({ seconds: "20", resolution: "720p" }), probe({ seconds: 20, resolution: "8k" }),
    probe({ seconds: 9.5, resolution: "720p" }), { ...probe(), id: "v1_other" },
  ]) {
    const result = plugin.parseTaskResult(query, body);
    assert.equal(result.status, "UNKNOWN", JSON.stringify(body).slice(0, 120));
    if (body.id === "v1_fixture") assert.throws(() => plugin.extractUsageOnComplete(query, { status: "SUCCESS" }, body));
  }
  assert.equal(plugin.parseTaskResult({ ...query, state: { seconds: 3 } }, probe()).status, "UNKNOWN", "unrequested probe");
  assert.throws(() => plugin.buildQueryRequest({ ...query, state: { ...state, probe_uri: "https://evil.invalid/a" } }));
  // Pre-1.3.0 extension snapshots (no added-seconds flag) keep full-output billing.
  const legacy = { taskId: "v1_fixture", action: "extend", state: { task: "extend", seconds: 40, probe_uri: stored } };
  assert.deepEqual(plugin.extractUsageOnComplete(legacy, { status: "SUCCESS" }, probe()), { seconds: 20.032, resolution: "720p" });
});

test("legacy extension snapshots bill the full playable movie when video and audio timelines differ", () => {
  for (const version of [0, 1]) {
    const query = { action: "extend", state: { task: "extend", seconds: 40 } };
    const data = completed({ type: "video", mime_type: "video/mp4", data: mp4(6, "360p", version, 9.024) });
    const result = plugin.parseTaskResult(query, data);
    assert.equal(result.status, "SUCCESS");
    assert.deepEqual(plugin.extractUsageOnComplete(query, result, data), { seconds: 9.024, resolution: "720p" }, "360p is billed as 720p");
    assert.equal(result.state.output_seconds, 9.024);
  }
});

test("40s results tolerate the verified audio tail but reject oversized movie or video timelines", () => {
  const query = { action: "extend", state: { task: "extend", seconds: 40 } };
  const valid = completed({ type: "video", mime_type: "video/mp4", data: mp4(40, "360p", 0, 40.363) });
  const result = plugin.parseTaskResult(query, valid);
  assert.equal(result.status, "SUCCESS");
  assert.deepEqual(plugin.extractUsageOnComplete(query, result, valid), { seconds: 40.363, resolution: "720p" });
  for (const data of [mp4(40, "360p", 0, 41.001), mp4(41, "360p", 0, 41)]) {
    assert.equal(plugin.parseTaskResult(query, completed({ type: "video", mime_type: "video/mp4", data })).status, "UNKNOWN");
  }
});

test("multi-turn inherits the previous video mode and never sends a conflicting task", () => {
  const request = plugin.buildSubmitRequest(driver({ previous_interaction_id: "v1_previous", temperature: 0, top_p: 1 }));
  assert.equal(request.body.previous_interaction_id, "v1_previous");
  assert.deepEqual(request.body.generation_config, { temperature: 0, top_p: 1 });
  assert.equal(plugin.buildSubmitRequest(driver({ previous_interaction_id: "v1_previous" })).body.generation_config, undefined);
  assert.throws(() => decode({ previous_interaction_id: "v1_previous", task: "text_to_video" }), /不能同时指定/);
});

test("new multi-turn reserves safely and bills the complete new MP4, not request or added seconds", () => {
  const ctx = driver({ previous_interaction_id: "v1_previous", duration: 3, resolution: "1080p" });
  assert.deepEqual(plugin.extractUsage(ctx), { seconds: 40, resolution: "1080p" });
  assert.equal(plugin.buildSubmitRequest(ctx).body.response_format[0].duration, "3s");
  const submitted = plugin.parseSubmitResponse(ctx, { body: { id: "v1_fixture", status: "in_progress" } });
  assert.equal(submitted.state.bill_output_duration, true);
  assert.equal(submitted.state.seconds, 40);
  assert.equal(submitted.state.requested_seconds, 3);
  const query = { taskId: "v1_fixture", action: "text_to_video", state: submitted.state };
  const waiting = plugin.parseTaskResult(query, completed({ type: "video", mime_type: "video/mp4", uri: stored }));
  assert.equal(waiting.status, "IN_PROGRESS");
  assert.equal(waiting.state.task, undefined, "continuation must not be reclassified as extend");
  const probed = { ...query, state: waiting.state };
  const body = probe({ seconds: 6.037, resolution: "1080p" });
  const result = plugin.parseTaskResult(probed, body);
  assert.equal(result.status, "SUCCESS");
  assert.deepEqual(plugin.extractUsageOnComplete(probed, result, body), { seconds: 6.037, resolution: "1080p" });
  const inline = completed({ type: "video", mime_type: "video/mp4", data: mp4(6, "1080p", 0, 6.037) });
  const immediate = plugin.parseSubmitResponse(ctx, { body: inline });
  assert.deepEqual(plugin.extractUsageOnComplete({ state: immediate.state }, immediate.immediate, immediate.taskData),
    { seconds: 6.037, resolution: "1080p" });
});

test("legacy continuation snapshots retain request billing while unmeasurable results fail closed", () => {
  const oldQuery = { action: "text_to_video", state: { seconds: 3, resolution: "1080p" } };
  const data = completed({ type: "video", mime_type: "video/mp4", data: mp4(6, "1080p", 0, 6.037) });
  assert.equal(plugin.parseTaskResult(oldQuery, data).status, "SUCCESS");
  assert.equal(plugin.extractUsageOnComplete(oldQuery, { status: "SUCCESS" }, data), null);
  const query = { taskId: "v1_fixture", state: { bill_output_duration: true, seconds: 40 } };
  const delivered = completed({ type: "video", mime_type: "video/mp4", uri: stored });
  assert.throws(() => plugin.extractUsageOnComplete(query, { status: "SUCCESS" }, delivered), /完整时长/);
  const external = completed({ type: "video", mime_type: "video/mp4", uri: "https://cdn.example.invalid/out.mp4" });
  assert.equal(plugin.parseTaskResult(query, external).status, "UNKNOWN");
});

test("all documented resolution and orientation sizes agree with wire and frozen usage", () => {
  for (const [size, resolution, ratio] of [
    ["640x360", "720p", "16:9"], ["360x640", "720p", "9:16"],
    ["1920x1080", "1080p", "16:9"], ["1080x1920", "1080p", "9:16"],
    ["3840x2160", "4k", "16:9"], ["2160x3840", "4k", "9:16"],
  ]) {
    const ctx = driver({ size });
    const format = plugin.buildSubmitRequest(ctx).body.response_format[0];
    assert.equal(format.resolution, resolution); assert.equal(format.aspect_ratio, ratio);
    assert.equal(plugin.extractUsage(ctx).resolution, resolution);
  }
  for (const value of [
    { size: "1080x1920", resolution: "720p" },
    { first_frame: still, firstFrame: "https://cdn.example.com/other.png" },
    { last_frame: still },
    { task: "text_to_video", image: still },
    { task: "image_to_video", image: still, video: clip },
    { temperature: true }, { temperature: null }, { temperature: 2.1 }, { top_p: 1.1 },
    { previous_interaction_id: "one", metadata: { previous_interaction_id: "two" } },
  ]) assert.throws(() => decode(value));
});

test("submission persists small state; polling has no dependency on requestBody or module globals", () => {
  const response = { id: "v1_fixture", status: "in_progress", steps: [
    { type: "user_input", content: [{ type: "image", data: "not-persisted" }] },
    { type: "thought", content: [{ text: "private thought" }] },
  ] };
  const submitted = plugin.parseSubmitResponse(driver({ duration: 6 }), { body: response });
  assert.deepEqual(submitted, { taskId: "v1_fixture", taskData: { id: "v1_fixture", status: "in_progress" },
    state: { seconds: 6, resolution: "720p", aspect_ratio: "16:9" } });
  const query = plugin.buildQueryRequest({ ...driver(), taskId: submitted.taskId, requestBody: undefined });
  assert.equal(query.method, "GET");
  assert.equal(query.url.endsWith("/interactions/v1_fixture"), true);
  assert.equal(plugin.extractUsageOnComplete({}, {}, { usage: { total_output_tokens: 30000 } }), null);
  assert.throws(() => plugin.parseSubmitResponse(driver(), { body: { status: "in_progress" } }), /勿重复提交/);
  assert.throws(() => plugin.parseSubmitResponse(driver(), {
    statusCode: 503, body: { id: "v1_fixture", status: "in_progress" },
  }), /HTTP 503/);
  assert.throws(() => plugin.buildQueryRequest({ ...driver(), taskId: "../other" }), /编号/);
});

test("poll lifecycle is strict and terminal errors remain legible", () => {
  for (const [status, expected, progress] of [["queued", "QUEUED", "0%"], ["in_progress", "IN_PROGRESS", "50%"],
    ["failed", "FAILURE", "100%"], ["cancelled", "FAILURE", "100%"], ["requires_action", "FAILURE", "100%"],
    ["completed", "FAILURE", "100%"], ["new-provider-state", "UNKNOWN", undefined]]) {
    const result = plugin.parseTaskResult({}, { id: "v1_fixture", status });
    assert.equal(result.status, expected);
    assert.equal(result.progress, progress);
  }
  assert.equal(plugin.parseTaskResult({}, null).status, "UNKNOWN");
  assert.equal(plugin.parseTaskResult({ taskId: "v1_wrong" }, completed()).status, "UNKNOWN");
  const error = { code: "IMAGE_POLICY_FILTERED", message: "Provider safety reason" };
  assert.equal(plugin.parseTaskResult({}, { errors: [error] }).reason, "[IMAGE_POLICY_FILTERED] Provider safety reason");
  assert.throws(() => plugin.parseSubmitResponse(driver(), { body: { error } }), /Provider safety reason/);
  const echoed = { id: "v1_fixture", status: "completed", steps: [
    { type: "user_input", content: [{ type: "video", mime_type: "video/mp4", uri: "gs://" + bucket + "/in.mp4" }] },
  ] };
  assert.equal(plugin.parseTaskResult({}, echoed).status, "FAILURE", "echoed input is never a result");
});

test("steps/outputs and flat/nested media produce results, including immediate completion", () => {
  for (const body of [completed(), { ...completed(), steps: [], outputs: completed().steps },
    { ...completed(), steps: [], outputs: completed().steps[0].content }]) {
    const result = plugin.parseTaskResult({}, body);
    assert.equal(result.status, "SUCCESS");
    assert.equal(result.url, "data:video/mp4;base64,dmlkZW8=");
    const submitted = plugin.parseSubmitResponse(driver(), { body });
    assert.equal(submitted.immediate.status, "SUCCESS");
    assert.equal(JSON.stringify(submitted.taskData).includes("dmlkZW8"), false);
  }
});

test("GCS downloads use Google auth, while signed external results never receive credentials", () => {
  const body = completed({ type: "video", mime_type: "video/mp4", uri: "gs://fixture-bucket/output/a+b.mp4" });
  const result = plugin.parseTaskResult({}, body);
  assert.equal(result.url, "https://storage.googleapis.com/storage/v1/b/fixture-bucket/o/output%2Fa%2Bb.mp4?alt=media");
  assert.deepEqual(plugin.listArtifacts({ status: "SUCCESS", data: body }), [{ key: "video", type: "video", mimeType: "video/mp4" }]);
  const content = plugin.buildContentRequest({ ...driver(), artifactKey: "video", data: body, clientRequest: { method: "HEAD" } });
  assert.equal(content.method, "HEAD");
  assert.equal(content.headers.Authorization, "Bearer fixture-token");
  assert.equal(content.credentialless, false);
  const signed = completed({ type: "video", uri: "https://cdn.example.invalid/video.mp4?signature=fixture" });
  const external = plugin.buildContentRequest({ ...driver(), artifactKey: "video", data: signed, clientRequest: { method: "GET" } });
  assert.equal(external.credentialless, true);
  assert.equal(external.headers, undefined);
  for (const uri of ["https://user:pass@example.invalid/v.mp4", "http://example.invalid/v.mp4", "file:///tmp/v.mp4"]) {
    assert.equal(plugin.parseTaskResult({}, completed({ type: "video", uri })).status, "FAILURE");
  }
});

test("malformed connections never construct credential-bearing requests", () => {
  for (const changes of [
    { baseUrl: "https://user:password@example.invalid" }, { baseUrl: "https://host.invalid?redirect=elsewhere" },
    { auth: { projectId: "../other" } }, { authHeader: "Bearer fixture\r\nX-Secret: leaked" },
    { upstream: { kind: "new_api" } },
  ]) {
    assert.throws(() => plugin.buildSubmitRequest({ ...driver(), ...changes }));
    assert.throws(() => plugin.buildPreflightRequest({ ...driver({ image: still }), ...changes }));
  }
  for (const suffix of ["/v1", "/v1beta1", "/"]) {
    assert.equal(plugin.buildSubmitRequest({ ...driver(), baseUrl: plugin.meta.baseUrl + suffix }).url,
      plugin.buildSubmitRequest(driver()).url);
  }
  assert.equal(plugin.buildSubmitRequest({ ...driver(), publicTaskId: undefined }).body.response_format[0].gcs_uri,
    "gs://" + bucket + "/vertex-omni/unassigned/");
});

// ---- 1.4.0: Omni Flash and Veo 3.1 / Fast (isolated test names) ----
const veoRoot = "https://us-central1-aiplatform.googleapis.com/v1/projects/fixture-project/locations/us-central1/publishers/google/models/";
const veoOp = name => "projects/fixture-project/locations/us-central1/publishers/google/models/" + name + "/operations/0b6c5f3a-1111-4222-8333-944455556666";

test("Omni Flash shares the Interactions wire but only 720p, without extension, edit or continuation", () => {
  const ctx = driver({ duration: 5 }, flashModel, "gemini-omni-flash-preview");
  const request = plugin.buildSubmitRequest(ctx);
  assert.equal(request.body.model, "gemini-omni-flash-preview");
  assert.deepEqual(request.body.response_format, [{ type: "video", duration: "5s", aspect_ratio: "16:9", resolution: "720p", ...delivery }]);
  assert.deepEqual(plugin.extractUsage(ctx), { seconds: 5, resolution: "720p" });
  const frames = plugin.buildSubmitRequest(ingested(driver({ first_frame: still, last_frame: clip.replace(".mp4", ".png") },
    flashModel, flashModel)));
  assert.equal(frames.body.generation_config.video_config.task, "image_to_video");
  assert.equal(plugin.buildSubmitRequest(ingested(driver({ images: [still, still] }, flashModel, flashModel)))
    .body.generation_config.video_config.task, "reference_to_video");
  for (const [value, message] of [[{ resolution: "1080p" }, /仅支持 720p/], [{ size: "3840x2160" }, /仅支持 720p/],
    [{ task: "extend", video: clip }, /不支持 extend/], [{ video: clip }, /不支持 edit/],
    [{ previous_interaction_id: "v1_previous" }, /不支持多轮/]]) assert.throws(() => decode(value, flashModel), message);
  assert.throws(() => plugin.buildSubmitRequest(driver({}, flashModel, upstream)), /精确上游型号/, "cannot map Flash onto Omni 1.1");
});

test("Veo text-to-video uses regional predictLongRunning with storageUri and audio-aware usage", () => {
  for (const [name, upstreamName] of [[veoModel, "veo-3.1-generate-001"], [veoFastModel, "veo-3.1-fast-generate-001"]]) {
    const ctx = driver({ duration: 4, size: "2160x3840", generate_audio: false, seed: 7, negative_prompt: "blur" }, name, upstreamName);
    assert.equal(plugin.buildPreflightRequest(ctx), null);
    const request = plugin.buildSubmitRequest(ctx);
    assert.equal(request.url, veoRoot + upstreamName + ":predictLongRunning");
    assert.equal(request.headers.Authorization, "Bearer fixture-token");
    assert.deepEqual(request.body, { instances: [{ prompt: "Fixture" }], parameters: {
      sampleCount: 1, generateAudio: false, storageUri: outputPrefix, durationSeconds: 4, aspectRatio: "9:16",
      resolution: "4k", negativePrompt: "blur", seed: 7 } });
    assert.equal(request.action, "text_to_video");
    assert.deepEqual(plugin.extractUsage(ctx), { seconds: 4, resolution: "4k", generate_audio: false });
  }
  const defaults = driver({}, veoModel, veoModel);
  assert.deepEqual(plugin.buildSubmitRequest(defaults).body.parameters, { sampleCount: 1, generateAudio: true,
    storageUri: outputPrefix, durationSeconds: 8, aspectRatio: "16:9", resolution: "720p" });
  assert.deepEqual(plugin.extractUsage(defaults), { seconds: 8, resolution: "720p", generate_audio: true });
  assert.equal(plugin.buildSubmitRequest({ ...defaults, baseUrl: "http://127.0.0.1:9999" }).url,
    "http://127.0.0.1:9999/v1/projects/fixture-project/locations/us-central1/publishers/google/models/veo-3.1-generate-001:predictLongRunning");
  assert.throws(() => plugin.buildSubmitRequest(driver({}, veoModel, "veo-3.1-fast-generate-001")), /精确上游型号/);
});

test("Veo first/last frame, references and extension map onto Veo instance fields", () => {
  const frames = plugin.buildSubmitRequest(ingested(driver({ first_frame: "https://cdn.example.com/a.jpg",
    last_frame: still, duration: 6 }, veoFastModel, veoFastModel)));
  assert.deepEqual(frames.body.instances, [{ prompt: "Fixture",
    image: { gcsUri: "gs://" + bucket + "/vertex-omni-inputs/2026-10-09/0.png", mimeType: "image/jpeg" },
    lastFrame: { gcsUri: "gs://" + bucket + "/vertex-omni-inputs/2026-10-09/1.png", mimeType: "image/png" } }]);
  assert.equal(frames.action, "image_to_video");
  const single = plugin.buildSubmitRequest(ingested(driver({ input_reference: still }, veoModel, veoModel)));
  assert.equal(single.action, "image_to_video", "one image without a task is the first frame");
  assert.ok(single.body.instances[0].image && !single.body.instances[0].referenceImages);
  const references = plugin.buildSubmitRequest(ingested(driver({ images: [still, still, still] }, veoModel, veoModel)));
  assert.equal(references.action, "reference_to_video");
  assert.equal(references.body.instances[0].referenceImages.length, 3);
  assert.deepEqual(references.body.instances[0].referenceImages[0].referenceType, "asset");
  assert.equal(references.body.parameters.durationSeconds, 8);
  const extend = driver({ task: "extend", video: clip }, veoFastModel, veoFastModel);
  assert.equal(plugin.buildPreflightRequest(extend).body.measure, true);
  const extension = plugin.buildSubmitRequest(ingested(extend, { seconds: 4, resolution: "720p" }));
  assert.deepEqual(extension.body.instances[0].video, { gcsUri: "gs://" + bucket + "/vertex-omni-inputs/2026-10-09/0.mp4", mimeType: "video/mp4" });
  assert.deepEqual(extension.body.parameters, { sampleCount: 1, generateAudio: true, storageUri: outputPrefix });
  assert.deepEqual(plugin.extractUsage(extend), { seconds: 8, resolution: "720p", generate_audio: true });
});

test("Veo requests are bounded to what Google accepts", () => {
  for (const [value, message] of [
    [{ duration: 5 }, /4、6 或 8/], [{ duration: 10 }, /4、6 或 8/], [{ resolution: "360p" }, /720p、1080p 或 4k/],
    [{ images: [still, still, still], duration: 4 }, /只支持 8 秒/], [{ images: [still, still, still, still] }, /1 到 3/],
    [{ task: "extend", video: clip, duration: 8 }, /固定新增 7 秒/], [{ task: "extend", video: clip, resolution: "1080p" }, /延长沿用/],
    [{ task: "extend", video: clip, size: "1280x720" }, /延长沿用/], [{ task: "edit", video: clip }, /只支持/],
    [{ task: "text_to_video", image: still }, /不能同时/], [{ generate_audio: "false" }, /true 或 false/],
    [{ seed: -1 }, /seed/], [{ temperature: 0.5 }, /不支持 temperature/], [{ previous_interaction_id: "v1_x" }, /不支持 previous/],
    [{ audio: "https://cdn.example.com/a.mp3" }, /音频/], [{ parameters: {} }, /由平台管理/], [{ n: 2 }, /只生成 1 个视频/],
    [{ video: "data:video/mp4;base64,AAAA", task: "extend" }, /HTTP\(S\) 链接/],
  ]) assert.throws(() => decode(value, veoModel), message, JSON.stringify(value));
  assert.throws(() => plugin.buildSubmitRequest(ingested(driver({ image: "https://cdn.example.com/a.webp" }, veoModel, veoModel),
    undefined, items => items.map(item => ({ ...item, mime_type: "image/webp" })))), /image\/jpeg、image\/png/);
  for (const [facts, message] of [[null, /可测量时长/], [{ seconds: 31 }, /截取末尾/]]) {
    assert.throws(() => plugin.buildSubmitRequest(ingested(driver({ task: "extend", video: clip }, veoModel, veoModel), facts)), message);
  }
});

test("Veo operations encode into safe task IDs, poll fetchPredictOperation and deliver gcsUri results", () => {
  const ctx = driver({ duration: 6, resolution: "1080p", generate_audio: false }, veoFastModel, "veo-3.1-fast-generate-001");
  const submitted = plugin.parseSubmitResponse(ctx, { body: { name: veoOp("veo-3.1-fast-generate-001") } });
  assert.match(submitted.taskId, /^[A-Za-z0-9_-]+$/);
  assert.deepEqual(submitted.taskData, { name: veoOp("veo-3.1-fast-generate-001") });
  assert.deepEqual(submitted.state, { family: "veo", seconds: 6, resolution: "1080p", aspect_ratio: "16:9", generate_audio: false });
  assert.throws(() => plugin.parseSubmitResponse(ctx, { body: { name: veoOp("veo-3.1-generate-001") } }), /非预期型号/);
  assert.throws(() => plugin.parseSubmitResponse(ctx, { body: { name: "operations/../x" } }), /格式不正确/);
  assert.throws(() => plugin.parseSubmitResponse(ctx, { body: { error: { code: 400, message: "Invalid resolution: 999p" } } }), /999p/);
  const query = { ...driver({}, veoFastModel, "veo-3.1-fast-generate-001"), taskId: submitted.taskId, state: submitted.state, requestBody: undefined };
  const request = plugin.buildQueryRequest(query);
  assert.equal(request.url, veoRoot + "veo-3.1-fast-generate-001:fetchPredictOperation");
  assert.equal(request.method, "POST");
  assert.deepEqual(request.body, { operationName: veoOp("veo-3.1-fast-generate-001") });
  assert.throws(() => plugin.buildQueryRequest({ ...query, taskId: "bm90LWFuLW9w" }), /格式不正确/);
  assert.deepEqual(plugin.parseTaskResult(query, { name: veoOp("veo-3.1-fast-generate-001") }), { status: "IN_PROGRESS", progress: "50%" });
  assert.equal(plugin.parseTaskResult(query, {}).status, "UNKNOWN");
  const failed = plugin.parseTaskResult(query, { name: "x", done: true, error: { code: 3, message: "Unsupported output video duration 5 seconds" } });
  assert.equal(failed.status, "FAILURE");
  assert.match(failed.reason, /Unsupported output video duration/);
  const filtered = plugin.parseTaskResult(query, { done: true, response: { raiMediaFilteredCount: 1, raiMediaFilteredReasons: ["Prompt blocked"] } });
  assert.deepEqual([filtered.status, filtered.reason], ["FAILURE", "Prompt blocked"]);
  const uri = outputPrefix + "1208296686290258483/sample_0.mp4";
  const done = { name: veoOp("veo-3.1-fast-generate-001"), done: true, response: { raiMediaFilteredCount: 0,
    videos: [{ gcsUri: uri, mimeType: "video/mp4" }] } };
  const result = plugin.parseTaskResult(query, done);
  assert.equal(result.status, "SUCCESS");
  assert.equal(result.url, "https://storage.googleapis.com/storage/v1/b/" + bucket + "/o/" +
    encodeURIComponent("vertex-omni/task_fixture01/1208296686290258483/sample_0.mp4") + "?alt=media");
  assert.equal(plugin.extractUsageOnComplete(query, result, done), null, "ordinary Veo bills the requested seconds");
  assert.deepEqual(plugin.listArtifacts({ status: "SUCCESS", data: done }), [{ key: "video", type: "video", mimeType: "video/mp4" }]);
  const content = plugin.buildContentRequest({ ...driver({}, veoFastModel, veoFastModel), artifactKey: "video", data: done, clientRequest: { method: "GET" } });
  assert.equal(content.headers.Authorization, "Bearer fixture-token");
  const inline = plugin.parseTaskResult(query, { done: true, response: { videos: [{ bytesBase64Encoded: "dmlkZW8=", mimeType: "video/mp4" }] } });
  assert.equal(inline.url, "data:video/mp4;base64,dmlkZW8=");
  assert.equal(plugin.parseTaskResult(query, { done: true, response: { videos: [{ gcsUri: "https://evil.invalid/v.mp4" }] } }).status, "FAILURE");
});

test("Veo extensions settle measured added seconds with the requested audio flag", () => {
  const ctx = ingested(driver({ task: "extend", video: clip, generate_audio: false }, veoModel, veoModel), { seconds: 4, resolution: "720p" });
  const submitted = plugin.parseSubmitResponse(ctx, { body: { name: veoOp("veo-3.1-generate-001") } });
  assert.deepEqual(submitted.state, { family: "veo", seconds: 8, resolution: "720p", aspect_ratio: "16:9", generate_audio: false,
    input_seconds: 4, bill_added_seconds: true, task: "extend" });
  const query = { ...driver({}, veoModel, veoModel), taskId: submitted.taskId, action: "extend", state: submitted.state, requestBody: undefined };
  const uri = outputPrefix + "9183078913211969829/sample_0.mp4";
  const waiting = plugin.parseTaskResult(query, { done: true, response: { videos: [{ gcsUri: uri, mimeType: "video/mp4" }] } });
  assert.equal(waiting.status, "IN_PROGRESS");
  assert.equal(waiting.state.probe_uri, uri);
  const probing = { ...query, state: waiting.state };
  assert.match(plugin.buildQueryRequest(probing).url, /^https:\/\/assets\.88api\.ai\/gcs\/probe\?id=/);
  const body = { ...probe({ seconds: 11, resolution: "720p", width: 1280, height: 720 }, uri), id: submitted.taskId };
  const result = plugin.parseTaskResult(probing, body);
  assert.equal(result.status, "SUCCESS");
  assert.deepEqual(plugin.extractUsageOnComplete(probing, result, body), { seconds: 7, resolution: "720p", generate_audio: false });
});

test("360p is not sold: Omni 1.1 upgrades it to 720p and the billing schema omits it", () => {
  assert.deepEqual(plugin.meta.usageSchema.resolution.enum, ["720p", "1080p", "4k"]);
  for (const value of [{ resolution: "360p" }, { size: "640x360" }, { metadata: { resolution: "360p" } }]) {
    const ctx = driver(value);
    assert.equal(plugin.buildSubmitRequest(ctx).body.response_format[0].resolution, "720p");
    assert.equal(plugin.extractUsage(ctx).resolution, "720p");
  }
  assert.throws(() => decode({ resolution: "360p", size: "1280x720", aspect_ratio: undefined, metadata: { resolution: "1080p" } }), /冲突/);
  assert.equal(plugin.buildSubmitRequest(driver({ resolution: "360p" }, flashModel, flashModel)).body.response_format[0].resolution, "720p");
  assert.throws(() => decode({ resolution: "1080p" }, flashModel), /仅支持 720p/, "Flash rejects unsupported resolutions");
  assert.throws(() => decode({ resolution: "360p" }, veoModel), /720p、1080p 或 4k/);
});

test("size also accepts a bare ratio, as older documentation showed", () => {
  for (const [name, upstreamName] of [[flashModel, "gemini-omni-flash-preview"], [model, upstream]]) {
    const body = plugin.buildSubmitRequest(driver({ size: "9:16" }, name, upstreamName)).body;
    assert.deepEqual([body.response_format[0].aspect_ratio, body.response_format[0].resolution], ["9:16", "720p"]);
  }
  const fourK = plugin.buildSubmitRequest(driver({ size: "16:9", resolution: "4k" })).body.response_format[0];
  assert.deepEqual([fourK.aspect_ratio, fourK.resolution], ["16:9", "4k"]);
  const veo = plugin.buildSubmitRequest(driver({ size: "9:16", resolution: "1080p" }, veoModel, veoModel)).body.parameters;
  assert.deepEqual([veo.aspectRatio, veo.resolution], ["9:16", "1080p"]);
  assert.throws(() => decode({ size: "9:16", aspect_ratio: "16:9" }), /冲突/);
  assert.throws(() => decode({ size: "1:1" }), /size 必须为 16:9、9:16/);
});
