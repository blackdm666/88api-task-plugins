import assert from 'node:assert/strict'
import test from 'node:test'
import * as plugin from '../plugins/sdgo-video/plugin.js'

const image = 'https://example.invalid/image.png'
const lastImage = 'https://example.invalid/last.png'
const video = 'https://example.invalid/video.mp4'
const audio = 'https://example.invalid/audio.mp3'

function decode(value = {}, model = 'doubao-seedance-2-5-260628') {
  return plugin.decodeRequest({
    model,
    body: { kind: 'json', value: { prompt: 'Fixture prompt', ...value } },
  })
}

test('declares the SDGO dynamic plugin and official models remain discoverable', () => {
  assert.equal(plugin.meta.key, 'sdgo-video')
  assert.equal(plugin.meta.name, 'SD-Video')
  assert.equal(plugin.meta.version, '1.0.4')
  assert.equal(plugin.meta.dynamicModels, true)
  assert.deepEqual(plugin.meta.usageSchema.resolution.enum, ['480p', '720p', '1080p', '4k'])
  assert.deepEqual(plugin.meta.usageSchema.video_input.enum, ['none', 'present'])
  assert.equal(plugin.meta.usageSchema.upstreamUnits.unit, 'token')
})

test('normalizes XM-style fields into Ark content items', () => {
  const decoded = decode({
    duration: -1,
    ratio: 'adaptive',
    resolution: '1080p',
    referenceImages: [image],
    referenceVideos: [video],
    referenceAudios: [audio],
    generateAudio: true,
    omniReferenceTaskType: 'reference',
  })
  assert.equal(decoded.action, 'image_to_video')
  assert.deepEqual(decoded.requestBody.content[0], { type: 'text', text: 'Fixture prompt' })
  assert.deepEqual(decoded.requestBody.content.slice(1), [
    { type: 'image_url', role: 'reference_image', image_url: { url: image } },
    { type: 'video_url', role: 'reference_video', video_url: { url: video } },
    { type: 'audio_url', role: 'reference_audio', audio_url: { url: audio } },
  ])
  assert.equal(decoded.requestBody.duration, -1)
  assert.equal(decoded.requestBody.resolution, '1080p')
  assert.equal(decoded.requestBody.omni_reference_task_type, 'reference')
})

test('preserves official content items and accepts a base URL with /api/v3', () => {
  const decoded = plugin.decodeRequest({
    model: 'doubao-seedance-2-0-260128',
    body: {
      kind: 'json',
      value: {
        model: 'ignored-by-host',
        content: [
          { type: 'text', text: 'Official prompt' },
          { type: 'image_url', role: 'first_frame', image_url: { url: image } },
        ],
        duration: 10,
        ratio: '16:9',
        resolution: '4k',
      },
    },
  })
  assert.equal(decoded.requestBody.content.length, 2)
  const submit = plugin.buildSubmitRequest({
    model: decoded.model,
    upstreamModel: decoded.model,
    requestBody: decoded.requestBody,
    baseUrl: 'https://sdgo.top/api/v3/',
    apiKey: 'fixture',
  })
  assert.equal(submit.url, 'https://sdgo.top/api/v3/contents/generations/tasks')
  assert.equal(submit.headers.Authorization, 'Bearer fixture')
  assert.equal(submit.body.content[1].role, 'first_frame')
  assert.equal(submit.body.resolution, '4k')
})

test('builds the documented task query and preserves gateway/Ark IDs', () => {
  const submitResponse = plugin.parseSubmitResponse({
    requestBody: { content: [{ type: 'text', text: 'Fixture prompt' }, { type: 'video_url', video_url: { url: video } }] },
  }, {
    body: { id: 'task_fixture', status: 'queued', model: 'doubao-seedance-2-5-260628' },
  })
  assert.deepEqual(submitResponse, {
    taskId: 'task_fixture',
    taskData: { id: 'task_fixture', status: 'queued', model: 'doubao-seedance-2-5-260628' },
    state: { video_input: 'present' },
  })
  const query = plugin.buildQueryRequest({
    baseUrl: 'https://sdgo.top/api/v3',
    taskId: 'task_fixture',
    apiKey: 'fixture',
  })
  assert.equal(query.url, 'https://sdgo.top/api/v3/contents/generations/tasks/task_fixture')
  const success = plugin.parseTaskResult({}, {
    id: 'cgt-fixture',
    status: 'succeeded',
    duration: 10,
    resolution: '1080p',
    content: { video_url: 'https://example.invalid/result.mp4' },
    usage: { completion_tokens: 216900, total_tokens: 216900 },
  })
  assert.equal(success.status, 'SUCCESS')
  assert.equal(success.url, 'https://example.invalid/result.mp4')
  assert.equal(success.completionTokens, 216900)
  assert.equal(success.totalTokens, 216900)
  assert.deepEqual(plugin.extractUsageOnComplete({ state: { video_input: 'present' } }, success, {
    id: 'cgt-fixture',
    status: 'succeeded',
    duration: 10,
    resolution: '1080p',
    usage: { completion_tokens: 216900 },
  }), { seconds: 10, resolution: '1080p', video_input: 'present', upstreamUnits: 216900 })
})

test('turns permanent provider query errors into terminal failures', () => {
  const result = plugin.parseTaskResult(
    {},
    { error: { code: 'InvalidParameter', message: 'input image is too small' } },
    { status: 400 },
  )
  assert.deepEqual(result, {
    status: 'FAILURE',
    progress: '100%',
    reason: 'input image is too small',
  })
})

test('extracts reference-video pricing from normalized Ark content', () => {
  const decoded = decode({ duration: 8, content: [
    { type: 'text', text: 'Fixture prompt' },
    { type: 'video_url', role: 'reference_video', video_url: { url: video } },
  ] })
  assert.deepEqual(plugin.extractUsage({ requestBody: decoded.requestBody }), {
    seconds: 8,
    resolution: '720p',
    video_input: 'present',
  })
  const textOnly = decode({ duration: 8 })
  assert.deepEqual(plugin.extractUsage({ requestBody: textOnly.requestBody }), {
    seconds: 8,
    resolution: '720p',
    video_input: 'none',
  })
})

test('enforces SDGO documented model and media limits', () => {
  assert.throws(() => decode({ duration: 3 }), /-1 或 4 到 30/)
  assert.throws(() => decode({ resolution: '4k' }, 'doubao-seedance-2-5-260628'), /当前模型不支持该分辨率/)
  assert.throws(() => decode({ resolution: '1080p' }, 'doubao-seedance-2-0-mini-260615'), /当前模型不支持该分辨率/)
  assert.throws(() => decode({ images: Array.from({ length: 31 }, (_, i) => `${image}?i=${i}`) }), /参考图片过多/)
  assert.throws(() => decode({ videos: Array.from({ length: 11 }, (_, i) => `${video}?i=${i}`) }), /参考视频过多/)
  assert.throws(() => decode({ audios: Array.from({ length: 11 }, (_, i) => `${audio}?i=${i}`) }), /参考音频过多/)
  assert.throws(() => decode({ audios: [audio] }, 'doubao-seedance-2-0-260128'), /必须同时提供参考图片或参考视频/)
  assert.throws(() => decode({ firstFrame: image, images: [lastImage] }), /不能与参考图片、视频或音频混用/)
  assert.throws(() => decode({ lastFrame: lastImage }), /请先提供首帧/)
  assert.throws(() => decode({ firstFrame: image, ratio: '16:9' }), /必须使用 adaptive/)
  assert.throws(() => decode({ output_format: 'mov' }, 'doubao-seedance-2-0-260128'), /不支持 output_format/)
  assert.throws(() => decode({ images: ['http://example.invalid/image.png'] }), /HTTPS、asset/)
})

test('supports 1.0 frames and forwards future Ark fields', () => {
  const decoded = decode({
    prompt: 'Frame fixture',
    duration: 8,
    frames: 29,
    seed: -1,
    service_tier: 'flex',
    safety_identifier: 'fixture-user',
    tools: [{ type: 'web_search' }],
  }, 'doubao-seedance-1-0-pro-250528')
  assert.equal(decoded.requestBody.frames, 29)
  assert.equal(decoded.requestBody.seed, -1)
  assert.equal(decoded.requestBody.service_tier, 'flex')
  assert.equal(decoded.requestBody.safety_identifier, 'fixture-user')
  assert.deepEqual(decoded.requestBody.tools, [{ type: 'web_search' }])
})

test('passes callback_url through unchanged for upstream delivery', () => {
  const callback_url = 'https://client.example.test/hooks/sdgo-task'
  const decoded = decode({
    prompt: 'Callback fixture',
    duration: 8,
    callback_url,
  }, 'doubao-seedance-1-0-pro-250528')
  assert.equal(decoded.requestBody.callback_url, callback_url)

  const submitted = plugin.buildSubmitRequest({
    baseUrl: 'https://sdgo.top/api/v3',
    apiKey: 'fixture-key',
    model: 'doubao-seedance-1-0-pro-250528',
    upstreamModel: 'doubao-seedance-1-0-pro-250528',
    requestBody: decoded.requestBody,
  })
  assert.equal(submitted.body.callback_url, callback_url)
})
