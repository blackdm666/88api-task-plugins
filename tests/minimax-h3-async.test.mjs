import test from 'node:test'
import assert from 'node:assert/strict'
import * as plugin from '../plugins/minimax-h3-async/plugin.js'

const decode = (value, model = 'minimax-h3-768p') => plugin.protocols.openai_video.decodeRequest({
  model, body: { kind: 'json', value: { prompt: 'Fixture', ...value } },
})
const driver = (value = {}, model = 'minimax-h3-768p') => ({
  model, upstreamModel: 'minimax-h3', baseUrl: 'https://example.invalid/',
  apiKey: 'fixture', publicTaskId: 'public-fixture',
  requestBody: decode(value, model).requestBody,
})

test('DMC-derived driver is separate and builds the exact asynchronous protocol', () => {
  assert.equal(plugin.meta.key, 'minimax-h3-async')
  const ctx = driver({ seconds: '15', ratio: '9:16', seed: 0 })
  const request = plugin.buildSubmitRequest(ctx)
  assert.equal(request.url, 'https://example.invalid/v1/api/generate')
  assert.equal(request.method, 'POST')
  assert.equal(request.headers.Authorization, 'Bearer fixture')
  assert.equal(request.headers['Idempotency-Key'], 'public-fixture')
  assert.deepEqual(request.body, {
    model: 'minimax-h3', prompt: 'Fixture', aspectRatio: 'portrait',
    resolution: '768p', duration: 15, replyType: 'async', seed: 0,
  })
  assert.deepEqual(plugin.extractUsage(ctx), { seconds: 15 })
  assert.equal(plugin.extractUsage({ ...ctx, usagePurpose: 'billing_ratios' }), null)
  assert.equal(plugin.extractUsageOnComplete({}, {}, { duration: 99999 }), null)
})

for (const resolution of ['480p', '768p', '1080p']) {
  test(`quality ${resolution} is pinned and bounded in decode, submission, and usage`, () => {
    const model = `minimax-h3-${resolution}`, max = resolution === '1080p' ? 10 : 15
    const ctx = driver({ duration: max }, model)
    assert.equal(plugin.buildSubmitRequest(ctx).body.resolution, resolution)
    assert.equal(plugin.extractUsage(ctx).seconds, max)
    assert.throws(() => decode({ duration: max + 1 }, model), /视频时长/)
    for (const hook of [plugin.buildSubmitRequest, plugin.extractUsage]) {
      assert.throws(() => hook({ ...ctx, requestBody: { prompt: 'Fixture', duration: max + 1 } }), /视频时长/)
      assert.throws(() => hook({ ...ctx, requestBody: { prompt: 'Fixture', resolution: resolution === '480p' ? '1080p' : '480p' } }), /分辨率/)
    }
  })
}

for (const value of [0, -1, 1.2, true, [], {}, null, '', ' ', 'Infinity', Number.MAX_VALUE]) {
  test(`invalid duration ${JSON.stringify(value)} cannot become a billing quantity`, () => {
    assert.throws(() => decode({ duration: value }), /视频时长/)
  })
}

for (const input of [
  { seconds: 5, duration: 6 }, { metadata: { seconds: 15 }, duration: 5 },
  { resolution: '1080p' }, { metadata: { resolution: '1080p' } },
  { size: '1:1' }, { ratio: '1:1' }, { ratio: 'adaptive' }, { size: '1024x1024' },
  { ratio: '16:9', aspectRatio: 'portrait' }, { size: '0x0' },
  { seed: 1.5 }, { seed: 0, metadata: { seed: 1 } }, { metadata: 'bad' },
  { videos: ['https://example.invalid/v'] },
  { metadata: { reference_videos: ['https://example.invalid/v'] } },
  { metadata: { firstFrame: 'https://example.invalid/i' } },
  { images: Array(10).fill('https://example.invalid/i') },
  { audios: Array(4).fill('https://example.invalid/a') },
  { media: [{ type: 'image_url', role: 'first_frame', image_url: 'https://example.invalid/i' }] },
  { images: [''], prompt: '' },
]) {
  test(`reject unsupported or conflicting input ${JSON.stringify(input).slice(0, 90)}`, () => {
    assert.throws(() => decode(input))
  })
}

test('reference images/audio and typed DMC references translate without first/last-frame semantics', () => {
  const raw = driver({ images: Array(9).fill('https://example.invalid/i'), audios: Array(3).fill('YXVkaW8=') })
  assert.equal(plugin.buildSubmitRequest(raw).body.images.length, 9)
  assert.equal(plugin.buildSubmitRequest(raw).body.audios.length, 3)
  const typed = driver({ metadata: { content: [
    { type: 'image_url', role: 'reference_image', image_url: { url: 'https://example.invalid/i' } },
    { type: 'audio_url', role: 'reference_audio', audio_url: 'YXVkaW8=' },
  ] } })
  assert.deepEqual(plugin.buildSubmitRequest(typed).body.images, ['https://example.invalid/i'])
  assert.deepEqual(plugin.buildSubmitRequest(typed).body.audios, ['YXVkaW8='])
})

test('multipart carries opaque uploaded refs; seed zero is retained', () => {
  const decoded = plugin.protocols.openai_video.decodeRequest({
    model: 'minimax-h3-480p',
    body: { kind: 'multipart', fields: { prompt: ['Fixture'], seconds: ['1'], seed: ['0'] },
      files: [{ ref: 'request_file:input_reference', field: 'input_reference', mimeType: 'image/png' }] },
  })
  assert.deepEqual(decoded.requestBody.images, [{ __fileRef: 'request_file:input_reference', encoding: 'dataUrl' }])
  assert.equal(decoded.requestBody.seed, 0)
})

test('model mapping cannot change the charged resolution or use an unknown protocol', () => {
  assert.throws(() => plugin.buildSubmitRequest({ ...driver(), upstreamModel: 'other-video' }), /模型/)
  assert.throws(() => plugin.buildSubmitRequest({ ...driver(), upstreamModel: 'minimax-h3-1080p' }), /分辨率/)
  assert.throws(() => decode({ resolution: '1080p' }, 'minimax-h3'), /模型名称/)
})

test('submission, polling, terminal failures, and progress protect the task lifecycle', () => {
  assert.deepEqual(plugin.parseSubmitResponse({}, { body: { id: 'job', status: 'running' } }),
    { taskId: 'job', taskData: { id: 'job', status: 'running' } })
  assert.throws(() => plugin.parseSubmitResponse({}, { body: { error: 'Original upstream error' } }), /Original upstream error/)
  assert.equal(plugin.buildQueryRequest({ baseUrl: 'https://example.invalid', taskId: 'id?&', apiKey: 'fixture' }).url,
    'https://example.invalid/v1/api/result?id=id%3F%26')
  assert.equal(plugin.parseTaskResult({}, { status: 'running', progress: 1 }).progress, '1%')
  assert.equal(plugin.parseTaskResult({}, { status: 'running', progress: 100 }).progress, '99%')
  assert.equal(plugin.parseTaskResult({}, { status: 'running', progress: -1 }).progress, '0%')
  assert.equal(plugin.parseTaskResult({}, { status: 'unexpected' }).status, 'UNKNOWN')
  assert.throws(() => plugin.parseTaskResult({ taskId: 'a' }, { id: 'b', status: 'running' }), /编号/)
  for (const status of ['failed', 'violation']) {
    const result = plugin.parseTaskResult({}, { status, error: 'Original 错误' })
    assert.deepEqual(result, { status: 'FAILURE', progress: '100%', reason: 'Original 错误' })
  }
  assert.equal(plugin.parseTaskResult({}, { status: 'succeeded', results: [] }).status, 'FAILURE')
  assert.equal(plugin.parseTaskResult({}, { status: 'succeeded', results: [{ url: 'javascript:bad' }] }).status, 'FAILURE')
})

test('successful result and artifacts use the flat upstream snapshot without leaking auth', () => {
  const data = { id: 'job', status: 'succeeded', results: [{ url: 'https://example.invalid/v.mp4' }] }
  assert.equal(plugin.parseSubmitResponse({}, { body: data }).immediate.status, 'SUCCESS')
  assert.equal(plugin.parseTaskResult({}, data).url, data.results[0].url)
  assert.deepEqual(plugin.listArtifacts({ status: 'SUCCESS', data }), [{ key: 'video', type: 'video', mimeType: 'video/mp4' }])
  assert.deepEqual(plugin.listArtifacts({ status: 'IN_PROGRESS', data }), [])
  assert.deepEqual(plugin.buildContentRequest({ artifactKey: 'video', data, clientRequest: { method: 'HEAD' } }),
    { url: data.results[0].url, method: 'HEAD', credentialless: true })
  const output = plugin.protocols.openai_video.render({}, {
    task_id: 'public', status: 'IN_PROGRESS', progress: '50%', updated_at: 5,
    properties: { origin_model_name: 'minimax-h3-768p' },
  })
  assert.equal(output.id, 'public')
  assert.equal(output.completed_at, undefined)
  assert.equal(output.model, 'minimax-h3-768p')
})
