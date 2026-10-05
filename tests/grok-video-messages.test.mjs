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
  assert.deepEqual(plugin.meta.models, ["grok-imagine-video-1.5"])
  assert.deepEqual(plugin.meta.usageSchema.resolution.enum, ["480p", "720p", "1080p"])
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
