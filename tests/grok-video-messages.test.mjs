import assert from "node:assert/strict"
import test from "node:test"

import * as plugin from "../plugins/grok-video/plugin.js"

function decode(value = {}) {
  return plugin.protocols.openai_video.decodeRequest({
    model: "grok-imagine-video-1.5",
    body: { kind: "json", value: { prompt: "Fixture prompt", ...value } },
  })
}

test("declares Grok model and resolution usage schema", () => {
  assert.equal(plugin.meta.key, "grok-video")
  assert.deepEqual(plugin.meta.models, ["grok-imagine-video-1.5", "grok-imagine-video"])
  assert.equal(plugin.meta.dynamicModels, true)
  assert.deepEqual(plugin.meta.usageSchema.resolution.enum, ["480p", "720p", "1080p"])
  assert.deepEqual(
    plugin.meta.usageProfiles.find((profile) => profile.models.includes("grok-imagine-video")).schema.resolution.enum,
    ["480p", "720p"],
  )
})

test("accepts an unknown future Grok model through the dynamic protocol", () => {
  const decoded = plugin.protocols.openai_video.decodeRequest({
    model: "grok-imagine-video-2",
    body: { kind: "json", value: { prompt: "Fixture prompt", resolution: "1080p" } },
  })
  assert.equal(decoded.model, "grok-imagine-video-2")
  assert.equal(decoded.requestBody.model, "grok-imagine-video-2")
  assert.equal(decoded.requestBody.resolution, "1080p")
})

test("keeps the base Grok model limited to 480p and 720p", () => {
  const decoded = plugin.protocols.openai_video.decodeRequest({
    model: "grok-imagine-video",
    body: { kind: "json", value: { prompt: "Fixture prompt", resolution: "720p" } },
  })
  assert.equal(decoded.requestBody.resolution, "720p")
  assert.throws(
    () => plugin.protocols.openai_video.decodeRequest({
      model: "grok-imagine-video",
      body: { kind: "json", value: { prompt: "Fixture prompt", resolution: "1080p" } },
    }),
    /不支持该分辨率/,
  )
})

test("normalizes resolution, duration, ratio, and image for Sub2API", () => {
  const decoded = decode({
    duration: 5,
    metadata: { resolution: "1080", aspect_ratio: "9:16" },
    image: "https://example.invalid/input.png",
  })
  assert.deepEqual(decoded.requestBody, {
    model: "grok-imagine-video-1.5",
    prompt: "Fixture prompt",
    duration: 5,
    aspect_ratio: "9:16",
    resolution: "1080p",
    image: { url: "https://example.invalid/input.png" },
  })
  const request = plugin.buildSubmitRequest({
    model: decoded.model,
    upstreamModel: decoded.model,
    requestBody: decoded.requestBody,
    baseUrl: "https://sub.example.invalid",
    apiKey: "fixture",
  })
  assert.equal(request.url, "https://sub.example.invalid/v1/videos/generations")
  assert.equal(request.body.resolution, "1080p")
  assert.equal(request.body.image.url, "https://example.invalid/input.png")
})

test("builds submit/query and settles from the Sub2API response", () => {
  const decoded = decode({ duration: 8, resolution: "720p" })
  const submitted = plugin.parseSubmitResponse(
    { requestBody: decoded.requestBody },
    { body: { request_id: "task_fixture", status: "queued" } },
  )
  assert.equal(submitted.taskId, "task_fixture")
  assert.deepEqual(submitted.state, { resolution: "720p" })

  const query = plugin.buildQueryRequest({
    baseUrl: "https://sub.example.invalid/",
    apiKey: "fixture",
    taskId: "task_fixture",
  })
  assert.equal(query.url, "https://sub.example.invalid/v1/videos/task_fixture")

  const result = plugin.parseTaskResult(
    { baseUrl: "https://sub.example.invalid" },
    {
      status: "completed",
      video: { url: "/videos/task_fixture.mp4", duration: 8 },
    },
    { status: 200 },
  )
  assert.deepEqual(result, {
    status: "SUCCESS",
    progress: "100%",
    url: "https://sub.example.invalid/videos/task_fixture.mp4",
  })
  assert.deepEqual(
    plugin.extractUsageOnComplete(submitted, result, {
      status: "completed",
      video: { url: "/videos/task_fixture.mp4", duration: 8 },
    }),
    { seconds: 8, resolution: "720p" },
  )
})

test("resolves relative result URLs without relying on unavailable URL global", () => {
  const result = plugin.parseTaskResult(
    { baseUrl: "https://sub.example.invalid/api" },
    {
      status: "completed",
      video: { url: "/videos/task_fixture.mp4", duration: 8 },
    },
    { status: 200 },
  )
  assert.equal(result.url, "https://sub.example.invalid/videos/task_fixture.mp4")
})

test("rejects unsupported resolution, duration, and multiple images", () => {
  assert.throws(() => decode({ resolution: "4k" }), /不支持该分辨率/)
  assert.throws(() => decode({ duration: 16 }), /1 到 15 秒/)
  assert.throws(() => decode({
    images: ["https://example.invalid/1.png", "https://example.invalid/2.png"],
  }), /最多接受一张/)
})

function content(url, overrides = {}) {
  return plugin.buildContentRequest({
    baseUrl: "http://sub2api:8080",
    apiKey: "fixture-secret",
    artifactKey: "video",
    data: { status: "done", video: { url } },
    clientRequest: { method: "GET" },
    ...overrides,
  })
}

test("authenticates relative and absolute Sub2API content without changing the task snapshot", () => {
  for (const url of [
    "/v1/videos/upstream/content",
    "http://sub2api:8080/v1/videos/upstream/content",
    "//sub2api:8080/v1/videos/upstream/content",
  ]) {
    const data = { status: "done", video: { url } }
    const request = content(url, { data })
    assert.equal(request.url, "http://sub2api:8080/v1/videos/upstream/content")
    assert.equal(request.credentialless, false)
    assert.deepEqual(request.headers, { Authorization: "Bearer fixture-secret" })
    assert.deepEqual(data, { status: "done", video: { url } })
  }
})

test("uses GET for protected HEAD and treats explicit default ports as the same origin", () => {
  const request = content("HTTPS://SUB.EXAMPLE.INVALID:443/v1/videos/upstream/content", {
    baseUrl: "https://sub.example.invalid/api",
    clientRequest: { method: "HEAD" },
  })
  assert.equal(request.method, "GET")
  assert.equal(request.credentialless, false)
  assert.equal(request.headers.Authorization, "Bearer fixture-secret")
})

test("preserves HEAD for external credentialless media", () => {
  const request = content("https://cdn.example.invalid/video.mp4", {
    clientRequest: { method: "HEAD" },
  })
  assert.equal(request.method, "HEAD")
  assert.equal(request.credentialless, true)
  assert.equal(request.headers, undefined)
})

test("never sends the channel key to another hostname, port, or scheme", () => {
  for (const url of [
    "https://cdn.example.invalid/video.mp4?signature=fixture",
    "//cdn.example.invalid/video.mp4",
    "http://sub2api:8081/video.mp4",
    "https://sub2api:8080/video.mp4",
    "http://sub2api.evil.invalid:8080/video.mp4",
  ]) {
    const request = content(url)
    assert.equal(request.credentialless, true)
    assert.equal(request.headers, undefined)
    assert.equal(request.body, undefined)
    assert.ok(!JSON.stringify(request).includes("fixture-secret"))
  }
})

test("fails closed on malformed result authorities and missing same-origin credentials", () => {
  for (const url of [
    "http://sub2api:8080@evil.invalid/video.mp4",
    "http://sub2api:8080\\@evil.invalid/video.mp4",
    "http://sub2api%2eevil.invalid:8080/video.mp4",
    "http://sub2api:99999/video.mp4",
    "http://sub2api:8080/video.mp4\r\nX-Test: injected",
  ]) {
    assert.throws(() => content(url), /视频地址/)
  }
  assert.throws(() => content("/v1/videos/upstream/content", { apiKey: "" }), /鉴权/)
  assert.throws(() => content("/v1/videos/upstream/content", { artifactKey: "poster" }), /暂不可用/)
})
