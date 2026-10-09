import assert from "node:assert/strict";
import test from "node:test";
import * as plugin from "../plugins/vertex-omni/plugin.js";

const model = "vertex-omni-1.1-test";
const upstream = "gemini-omni-1.1-flash-preview";
const bucket = "88api-omni-media";
const outputPrefix = "gs://" + bucket + "/vertex-omni/task_fixture01/";
const delivery = { delivery: "uri", gcs_uri: outputPrefix };
const stored = outputPrefix + "123.mp4";
const clip = "https://cdn.example.com/clip.mp4";
const still = "https://cdn.example.com/still.png";
function decode(value = {}) {
  return plugin.protocols.openai_video.decodeRequest({
    model, body: { kind: "json", value: { prompt: "Fixture", ...value } },
  });
}
function driver(value = {}) {
  return { model, upstreamModel: upstream, baseUrl: "https://aiplatform.googleapis.com",
    authHeader: "Bearer fixture-token", auth: { projectId: "fixture-project" }, publicTaskId: "task_fixture01",
    requestBody: decode(value).requestBody };
}
// Simulate the Worker's preflight answer for exactly what the plugin asked.
function ingested(ctx, facts = { seconds: 10, resolution: "720p" }, edit = items => items) {
  const preflight = plugin.buildPreflightRequest(ctx);
  assert.ok(preflight, "media requests always preflight");
  const items = preflight.body.items.map((item, index) => ({
    url: item.url, kind: item.kind, size: 1234,
    uri: "gs://" + bucket + "/vertex-omni-inputs/2026-10-09/" + index + (item.kind === "video" ? ".mp4" : ".png"),
    mime_type: item.kind === "video" ? "video/mp4" : "image/png",
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

test("QA manifest does not intercept production Vertex, Veo or Omni models", () => {
  assert.equal(plugin.meta.key, "vertex-omni");
  assert.equal(plugin.meta.version, "1.3.0");
  assert.deepEqual(plugin.meta.requiredCapabilities, ["task-preflight@1"], "no SSE host capability");
  assert.deepEqual(plugin.meta.allowedHosts, ["storage.googleapis.com", "assets.88api.ai"]);
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

test("inputs are HTTP(S) URLs only; Data URI, bucket, object and file references are rejected", () => {
  for (const url of [clip, "http://cdn.example.com/a.mp4", "https://cdn.example.com/a.mp4?sig=x&t=1",
    "https://cdn.example.com:8443/path/a%20b.mp4#frag"]) assert.equal(decode({ video: url }).action, "edit");
  for (const value of [
    { video: "data:video/mp4;base64,dmlkZW8=" }, { image: "data:image/png;base64,aW1hZ2U=" },
    { image: "gs://fixture-bucket/image.webp" }, { video: "ftp://cdn.example.com/a.mp4" },
    { image: "https://user:pass@cdn.example.com/a.png" }, { image: "https://cdn.example.com/a b.png" },
    { image: "https:///a.png" }, { image: "https://cdn.example.com/" + "a".repeat(4100) },
    { image: { uri: still } }, { image: { __fileRef: "request_file:image", mimeType: "image/png" } },
    { images: "not-array" }, { videos: Array(4).fill(clip) }, { images: Array(11).fill(still) },
    { metadata: { previous_interaction_id: "../bad" } },
  ]) assert.throws(() => decode(value), undefined, JSON.stringify(value).slice(0, 80));
  assert.throws(() => decode({ video: "data:video/mp4;base64,dmlkZW8=" }), /HTTP\(S\) URL/);
  assert.throws(() => plugin.protocols.openai_video.decodeRequest({ model, body: { kind: "multipart",
    fields: { prompt: ["Fixture"] }, files: [{ ref: "request_file:video", field: "video", size: 4, mimeType: "video/mp4" }] } }), /JSON/);
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
    ["mime", ingested(ctx, undefined, items => items.map(item => ({ ...item, mime_type: "image/svg+xml" }))), /不一致/],
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
    [{ ...base, resolution: "4k" }, /720p 或 1080p/], [{ ...base, resolution: "360p" }, /720p 或 1080p/],
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
    assert.deepEqual(plugin.extractUsageOnComplete(query, result, data), { seconds: 9.024, resolution: "360p" });
    assert.equal(result.state.output_seconds, 9.024);
  }
});

test("40s results tolerate the verified audio tail but reject oversized movie or video timelines", () => {
  const query = { action: "extend", state: { task: "extend", seconds: 40 } };
  const valid = completed({ type: "video", mime_type: "video/mp4", data: mp4(40, "360p", 0, 40.363) });
  const result = plugin.parseTaskResult(query, valid);
  assert.equal(result.status, "SUCCESS");
  assert.deepEqual(plugin.extractUsageOnComplete(query, result, valid), { seconds: 40.363, resolution: "360p" });
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
