import assert from 'node:assert/strict'
import test from 'node:test'
import * as plugin from '../plugins/gx-video/plugin.js'

const image = 'https://example.invalid/image.png'
const video = 'https://example.invalid/video.mp4'
const audio = 'https://example.invalid/audio.mp3'

function decode(value = {}, model = 'artsdance-2-5-pro-260801') {
  return plugin.decodeRequest({
    model,
    body: { kind: 'json', value: { prompt: 'Fixture prompt', ...value } },
  })
}

test('declares GX dynamic models and normalized usage dimensions', () => {
  assert.equal(plugin.meta.key, 'gx-video')
  assert.equal(plugin.meta.dynamicModels, true)
  assert.deepEqual(plugin.meta.usageSchema.resolution.enum, ['480p', '720p', '1080p'])
  assert.equal(plugin.meta.usageExamples[0].facts.seconds, 5)
})

test('normalizes XM-style inputs into the GX native request', () => {
  const decoded = decode({
    duration: -1,
    ratio: 'adaptive',
    resolution: '1080P',
    referenceImages: [image],
    referenceVideos: [video],
    referenceAudios: [audio],
    firstFrame: image,
    lastFrame: 'https://example.invalid/last.png',
    generateAudio: true,
    outputFormat: 'mov',
    omniReferenceTaskType: 'edit',
    seed: 7,
    camera_fixed: false,
  })
  assert.equal(decoded.action, 'image_to_video')
  assert.deepEqual(decoded.requestBody.content, [{ type: 'text', text: 'Fixture prompt' }])
  assert.equal(decoded.requestBody.duration, -1)
  assert.equal(decoded.requestBody.ratio, 'adaptive')
  assert.equal(decoded.requestBody.resolution, '1080p')
  assert.equal(decoded.requestBody.output_format, 'mov')
  assert.equal(decoded.requestBody.omni_reference_task_type, 'edit')
  assert.equal(decoded.requestBody.seed, 7)
  assert.equal(decoded.requestBody.images.length, 3)
  assert.equal(decoded.requestBody.videos[0].role, 'reference_video')
  assert.equal(decoded.requestBody.audios[0].role, 'reference_audio')
})

test('builds the documented GX submit and query requests', () => {
  const decoded = decode({ duration: 8, ratio: '16:9', images: [image] })
  const submit = plugin.buildSubmitRequest({
    model: decoded.model,
    upstreamModel: decoded.model,
    requestBody: decoded.requestBody,
    baseUrl: 'https://gengxi.ai/',
    apiKey: 'fixture',
  })
  assert.equal(submit.url, 'https://gengxi.ai/api/v3/contents/generations/tasks')
  assert.equal(submit.headers.Authorization, 'Bearer fixture')
  assert.equal(submit.body.model, 'artsdance-2-5-pro-260801')
  assert.equal(submit.body.duration, 8)
  assert.equal(submit.body.images[0].url, image)

  const query = plugin.buildQueryRequest({
    baseUrl: 'https://gengxi.ai/',
    taskId: 'cgt/fixture',
    apiKey: 'fixture',
  })
  assert.equal(query.url, 'https://gengxi.ai/api/v3/contents/generations/tasks/cgt%2Ffixture')
})

test('preserves provider task evidence and token fields', () => {
  const success = plugin.parseTaskResult({}, {
    id: 'cgt-1',
    status: 'succeeded',
    duration: 10,
    resolution: '720p',
    content: { video_url: 'https://example.invalid/result.mp4' },
    usage: { completion_tokens: 189347, total_tokens: 189347 },
  })
  assert.equal(success.status, 'SUCCESS')
  assert.equal(success.url, 'https://example.invalid/result.mp4')
  assert.equal(success.completionTokens, 189347)
  assert.equal(success.totalTokens, 189347)
  assert.deepEqual(plugin.extractUsageOnComplete({}, success, {
    status: 'succeeded',
    duration: 10,
    resolution: '720p',
  }), { seconds: 10, resolution: '720p' })

  assert.deepEqual(plugin.parseTaskResult({}, { status: 'queued' }).status, 'QUEUED')
  assert.deepEqual(plugin.parseTaskResult({}, { status: 'running', progress: 100 }).progress, '99%')
  assert.equal(plugin.parseTaskResult({}, {
    status: 'failed',
    error: { message: 'provider rejected the reference video' },
  }).reason, 'provider rejected the reference video')
  assert.match(plugin.parseTaskResult({}, { status: 'unknown' }).reason, /无需重新提交/)
})

test('validates documented limits and secure media URLs', () => {
  assert.throws(() => plugin.decodeRequest({ model: 'artsdance-2-5-pro-260801', body: { kind: 'json', value: [] } }), /JSON 对象/)
  assert.throws(() => decode({ duration: 3 }), /-1 或 4 到 30/)
  assert.throws(() => decode({ duration: 31 }), /-1 或 4 到 30/)
  assert.throws(() => decode({ ratio: '2:1' }), /当前模型不支持该画幅比例/)
  assert.throws(() => decode({ resolution: '2k' }), /当前模型不支持该分辨率/)
  assert.throws(() => decode({ images: Array.from({ length: 31 }, (_, i) => `${image}?i=${i}`) }), /参考图片过多/)
  assert.throws(() => decode({ videos: Array.from({ length: 11 }, (_, i) => `${video}?i=${i}`) }), /参考视频过多/)
  assert.throws(() => decode({ audios: Array.from({ length: 11 }, (_, i) => `${audio}?i=${i}`) }), /参考音频过多/)
  assert.throws(() => decode({ images: ['http://example.invalid/image.png'] }), /HTTPS URL/)
  assert.throws(() => decode({ lastFrame: image }), /先提供首帧/)
  assert.throws(() => decode({ output_format: 'webm' }), /只支持 mp4 或 mov/)
  assert.throws(() => decode({ omni_reference_task_type: 'unknown' }), /只支持 auto、edit 或 extend/)
})
