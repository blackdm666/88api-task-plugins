import assert from "node:assert/strict";
import test from "node:test";
import * as plugin from "../plugins/vertex-omni/plugin.js";

const model = "vertex-omni-1.1-test";
const upstream = "gemini-omni-1.1-flash-preview";
function decode(value = {}) {
  return plugin.protocols.openai_video.decodeRequest({
    model, body: { kind: "json", value: { prompt: "Fixture", ...value } },
  });
}
function driver(value = {}) {
  return { model, upstreamModel: upstream, baseUrl: "https://aiplatform.googleapis.com",
    authHeader: "Bearer fixture-token", auth: { projectId: "fixture-project" },
    requestBody: decode(value).requestBody };
}
function completed(part = { type: "video", mime_type: "video/mp4", data: "dmlkZW8=" }) {
  return { id: "v1_fixture", status: "completed", steps: [{ type: "model_output", content: [part] }] };
}
function mp4(seconds, resolution = "720p", version = 0) {
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
  const hdlr = Buffer.alloc(24); hdlr.write("vide", 8);
  const tkhd = Buffer.alloc(84);
  const [width, height] = { "360p": [640, 360], "720p": [1280, 720], "1080p": [1920, 1080], "4k": [3840, 2160] }[resolution];
  tkhd.writeUInt32BE(width * 65536, 76); tkhd.writeUInt32BE(height * 65536, 80);
  return Buffer.concat([
    atom("ftyp", Buffer.from("isom0000")),
    // mdat is deliberately not interpreted, even with fake metadata markers.
    atom("mdat", Buffer.from("fake-mvhd-mdhd-never-read")),
    atom("moov", atom("mvhd", mdhd), atom("trak", atom("tkhd", tkhd), atom("mdia", atom("mdhd", mdhd), atom("hdlr", hdlr)))),
  ]).toString("base64");
}

test("QA manifest does not intercept production Vertex, Veo or Omni models", () => {
  assert.equal(plugin.meta.key, "vertex-omni");
  assert.equal(plugin.meta.version, "1.1.0");
  assert.deepEqual(plugin.meta.models, [model]);
  assert.equal(plugin.meta.channelTypes, undefined);
  assert.equal(plugin.meta.dynamicModels, undefined);
  assert.deepEqual(plugin.meta.auth, { type: "oauth2_jwt" });
  for (const name of ["gemini-omni-flash", "gemini-omni-flash-1.1", upstream, "veo-3.1"]) {
    assert.throws(() => plugin.protocols.openai_video.decodeRequest({
      model: name, body: { kind: "json", value: { prompt: "Fixture" } },
    }), /独立测试模型/);
  }
});

test("bounded usage and Interactions wire agree, including all supported duration aliases", () => {
  for (const value of [{ duration: 3 }, { seconds: "10" }, { metadata: { duration_seconds: 4 } },
    { metadata: { durationSeconds: 6 } }]) {
    const ctx = driver({ ...value, size: "720x1280" });
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
      type: "video", aspect_ratio: "9:16", resolution: "720p", duration: String(usage.seconds) + "s",
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
    { task: "unknown" }, { audios: ["data:audio/mpeg;base64,YQ=="] },
  ]) assert.throws(() => decode(value));
  for (const value of [{ duration: 11 }, { duration: 4, seconds: 3 }, { n: 100 }]) {
    assert.throws(() => plugin.extractUsage({ model, requestBody: { prompt: "Fixture", ...value } }));
    assert.throws(() => plugin.buildSubmitRequest({ ...driver(), requestBody: { prompt: "Fixture", ...value } }));
  }
});

test("image/video references use documented typed parts without silently downloading HTTP input", () => {
  const request = plugin.buildSubmitRequest(driver({
    video: "data:video/mp4;base64,dmlkZW8=",
    images: ["data:image/png;base64,aW1hZ2U=", "gs://fixture-bucket/image.webp"],
    metadata: { previous_interaction_id: "v1_previous", output_gcs_uri: "gs://fixture-bucket/out/" },
  }));
  assert.equal(request.action, "reference_to_video");
  assert.deepEqual(request.body.input[0].content.map(part => part.type), ["video", "image", "image", "text"]);
  assert.equal(request.body.input[0].content[0].data, "dmlkZW8=");
  assert.equal(request.body.input[0].content[2].uri, "gs://fixture-bucket/image.webp");
  assert.equal(request.body.previous_interaction_id, "v1_previous");
  assert.equal(request.body.response_format[0].delivery, "uri");
  assert.equal(request.body.generation_config.video_config.task, "reference_to_video");
  for (const value of [
    { images: "not-array" }, { videos: Array(4).fill("gs://fixture-bucket/a.mp4") },
    { images: Array(11).fill("gs://fixture-bucket/a.png") },
    { images: ["https://assets.example.invalid/a.png"] },
    { videos: ["http://127.0.0.1/input.mp4"] }, { image: "data:image/svg+xml;base64,eA==" },
    { image: "data:image/png;base64,%%%" }, { videos: ["data:video/mp4;base64,YQ"] },
    { metadata: { previous_interaction_id: "../bad" } },
  ]) assert.throws(() => decode(value));
});

test("official Omni modes, sampling, frame roles, and total-duration extension billing are explicit", () => {
  const highQuality = plugin.buildSubmitRequest(driver({
    duration: 10, resolution: "4k", temperature: 0.4, top_p: 0.8,
  }));
  assert.equal(highQuality.body.response_format[0].resolution, "4k");
  assert.deepEqual(highQuality.body.generation_config, {
    video_config: { task: "text_to_video" }, temperature: 0.4, top_p: 0.8,
  });
  assert.deepEqual(plugin.extractUsage({ model, requestBody: decode({
    duration: 10, resolution: "4k", temperature: 0.4, top_p: 0.8,
  }).requestBody }), { seconds: 10, resolution: "4k" });

  const reference = plugin.buildSubmitRequest(driver({
    task: "reference_to_video",
    videos: ["data:video/mp4;base64,dmlkZW8=", "data:video/mp4;base64,dmlkZW8=", "data:video/mp4;base64,dmlkZW8="],
  }));
  assert.equal(reference.body.input[0].content.filter(part => part.type === "video").length, 3);
  assert.equal(reference.body.generation_config.video_config.task, "reference_to_video");

  const frames = plugin.buildSubmitRequest(driver({
    task: "image_to_video",
    first_frame: "data:image/png;base64,YQ==",
    last_frame: "data:image/png;base64,Yg==",
  }));
  assert.deepEqual(frames.body.input[0].content.slice(0, 2).map(part => part.data), ["YQ==", "Yg=="]);
  assert.ok(frames.body.input[0].content.every(part => part.role === undefined));
  assert.match(frames.body.input[0].content[2].text, /first image.*first frame.*second image.*last frame/);

  const edit = plugin.buildSubmitRequest(driver({
    task: "edit", video: "data:video/mp4;base64,dmlkZW8=", duration: 3,
  }));
  assert.deepEqual(edit.body.response_format, [{ type: "video" }]);
  assert.equal(edit.body.generation_config.video_config.task, "edit");

  const extend = driver({
    task: "extend", video: "data:video/mp4;base64," + mp4(3),
    duration: 6, input_duration: 3,
  });
  const extension = plugin.buildSubmitRequest(extend);
  assert.deepEqual(extension.body.response_format, [{ type: "video" }]);
  assert.equal(extension.body.generation_config.video_config.task, "extend");
  assert.deepEqual(plugin.extractUsage(extend), { seconds: 6, resolution: "720p" });
  assert.throws(() => decode({
    task: "extend", video: "data:video/mp4;base64," + mp4(3), duration: 3, input_duration: 3,
  }), /大于输入/);
});

test("extension settles full output movie duration, not added seconds, tokens, or client hints", () => {
  for (const version of [0, 1]) {
    const ctx = driver({ task: "extend", video: "data:video/mp4;base64," + mp4(3), duration: 6 });
    const submitted = plugin.parseSubmitResponse(ctx, { body: { id: "v1_fixture", status: "in_progress" } });
    assert.equal(submitted.state.input_seconds, 3);
    const query = { taskId: "v1_fixture", action: "extend", state: submitted.state };
    const data = completed({ type: "video", mime_type: "video/mp4", data: mp4(9, "360p", version) });
    data.duration = 999; data.usage = { total_output_tokens: 17376 };
    const parsed = plugin.parseTaskResult(query, data);
    assert.equal(parsed.status, "SUCCESS");
    assert.equal(parsed.state.output_seconds, 9);
    assert.deepEqual(plugin.extractUsageOnComplete(query, parsed, data), { seconds: 9, resolution: "360p" });
    const immediate = plugin.parseSubmitResponse(ctx, { body: data });
    assert.equal(immediate.immediate.status, "SUCCESS");
    assert.deepEqual(plugin.extractUsageOnComplete({ action: "extend", state: immediate.state },
      immediate.immediate, immediate.taskData), { seconds: 9, resolution: "360p" });
  }
  const base = { task: "extend", video: "data:video/mp4;base64," + mp4(3) };
  assert.equal(plugin.extractUsage(driver(base)).seconds, 40);
  assert.throws(() => decode({ ...base, video: "data:video/mp4;base64," + mp4(31) }), /1 到 30/);
  assert.throws(() => decode({ ...base, metadata: { output_gcs_uri: "gs://fixture-bucket/out/" } }), /内联 MP4/);
  assert.throws(() => decode({ ...base, size: "1280x720" }), /沿用输入画面/);
  assert.throws(() => decode({ ...base, resolution: "4k" }), /沿用输入分辨率/);
  assert.equal(plugin.parseTaskResult({ action: "extend" }, completed()).status, "UNKNOWN");
  assert.equal(plugin.extractUsageOnComplete({}, {}, { usage: { total_tokens: 99999 } }), null);
});

test("all documented resolution and orientation sizes agree with wire and frozen usage", () => {
  for (const [size, resolution, ratio] of [
    ["640x360", "360p", "16:9"], ["360x640", "360p", "9:16"],
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
    { first_frame: "data:image/png;base64,YQ==", firstFrame: "data:image/png;base64,Yg==" },
    { last_frame: "data:image/png;base64,YQ==" },
    { task: "text_to_video", image: "data:image/png;base64,YQ==" },
    { task: "image_to_video", image: "data:image/png;base64,YQ==", video: "data:video/mp4;base64,dmlkZW8=" },
    { temperature: true }, { temperature: null }, { temperature: 2.1 }, { top_p: 1.1 },
    { previous_interaction_id: "one", metadata: { previous_interaction_id: "two" } },
  ]) assert.throws(() => decode(value));
});

test("multipart parsing preserves repeated file identities and rejects repeated scalars or oversized input", () => {
  const body = { kind: "multipart", fields: { prompt: ["Fixture"], seconds: ["4"], size: ["720x1280"] },
    files: [
      { ref: "request_file:images", field: "images", size: 4, mimeType: "image/png" },
      { ref: "request_file:images#1", field: "images", size: 4, mimeType: "image/jpeg" },
      { ref: "request_file:video", field: "video", size: 4, mimeType: "video/mp4" },
    ] };
  const decoded = plugin.protocols.openai_video.decodeRequest({ model, body });
  const request = plugin.buildSubmitRequest({ ...driver(), requestBody: decoded.requestBody });
  assert.deepEqual(request.body.input[0].content.slice(0, 3).map(part => part.data.__fileRef),
    ["request_file:video", "request_file:images", "request_file:images#1"]);
  assert.equal(request.body.input[0].content[0].data.maxBytes, 64 * 1024 * 1024);
  assert.equal(request.body.input[0].content[1].data.maxBytes, 20 * 1024 * 1024);
  for (const invalid of [
    { ...body, fields: { ...body.fields, duration: ["3", "4"] } },
    { ...body, files: [{ ref: "request_file:video", field: "video", size: 64 * 1024 * 1024 + 1, mimeType: "video/mp4" }] },
    { ...body, fields: { ...body.fields, metadata: ["not-json"] } },
  ]) assert.throws(() => plugin.protocols.openai_video.decodeRequest({ model, body: invalid }));
});

test("JSON and file references enforce exact byte limits", () => {
  const tooLargeImage = Buffer.alloc(20 * 1024 * 1024 + 1).toString("base64");
  assert.throws(() => decode({ image: "data:image/png;base64," + tooLargeImage }), /大小/);
  assert.throws(() => decode({ image: { __fileRef: "malicious", mimeType: "image/png" } }), /文件引用/);
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
    { type: "user_input", content: [{ type: "video", mime_type: "video/mp4", data: "dmlkZW8=" }] },
  ] };
  assert.equal(plugin.parseTaskResult({}, echoed).status, "FAILURE");
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
  ]) assert.throws(() => plugin.buildSubmitRequest({ ...driver(), ...changes }));
  for (const suffix of ["/v1", "/v1beta1", "/"]) {
    assert.equal(plugin.buildSubmitRequest({ ...driver(), baseUrl: plugin.meta.baseUrl + suffix }).url,
      plugin.buildSubmitRequest(driver()).url);
  }
});
