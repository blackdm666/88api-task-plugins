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

test("QA manifest does not intercept production Vertex, Veo or Omni models", () => {
  assert.equal(plugin.meta.key, "vertex-omni");
  assert.equal(plugin.meta.version, "1.0.1");
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
    { size: "720x1280", aspect_ratio: "16:9" }, { size: "1920x1080" },
    { n: 2 }, { n: null }, { metadata: { candidate_count: 3 } }, { resolution: "1080p" },
    { metadata: { resolution: "4k" } }, { response_format: [] }, { generation_config: {} },
    { background: false }, { store: false }, { stream: true }, { model: "veo-3.1" },
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
  assert.equal(request.action, "video_to_video");
  assert.deepEqual(request.body.input[0].content.map(part => part.type), ["video", "image", "image", "text"]);
  assert.equal(request.body.input[0].content[0].data, "dmlkZW8=");
  assert.equal(request.body.input[0].content[2].uri, "gs://fixture-bucket/image.webp");
  assert.equal(request.body.previous_interaction_id, "v1_previous");
  assert.equal(request.body.response_format[0].delivery, "uri");
  for (const value of [
    { images: "not-array" }, { videos: ["gs://fixture-bucket/a.mp4", "gs://fixture-bucket/b.mp4"] },
    { images: Array(11).fill("gs://fixture-bucket/a.png") },
    { images: ["https://assets.example.invalid/a.png"] },
    { videos: ["http://127.0.0.1/input.mp4"] }, { image: "data:image/svg+xml;base64,eA==" },
    { image: "data:image/png;base64,%%%" }, { videos: ["data:video/mp4;base64,YQ"] },
    { metadata: { previous_interaction_id: "../bad" } },
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
