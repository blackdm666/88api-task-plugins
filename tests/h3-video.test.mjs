import test from 'node:test'
import assert from 'node:assert/strict'
import * as plugin from '../plugins/h3-video/plugin.js'

const decode = (value, model = 'minimax-h3-768p', upstreamModel = 'minimax_h3') => plugin.protocols.openai_video.decodeRequest({
  model, upstreamModel, body: { kind: 'json', value: { prompt: 'Fixture', ...value } },
})
const driver = (value = {}, model = 'minimax-h3-768p', upstreamModel = 'minimax_h3') => ({
  model, upstreamModel, baseUrl: 'https://example.invalid/', apiKey: 'fixture', publicTaskId: 'task_public01',
  requestBody: decode(value, model, upstreamModel).requestBody,
})
const image = 'https://example.invalid/i.png'
const cdn = 'https://cdn.example.invalid/video.mp4?X-Amz-Signature=abc'

test('text-to-video builds the exact upstream request with idempotency and frozen seconds', () => {
  assert.equal(plugin.meta.key, 'h3-video')
  assert.equal(plugin.meta.name, 'H3-Video')
  const ctx = driver({ seconds: '6', ratio: '9:16' })
  const request = plugin.buildSubmitRequest(ctx)
  assert.equal(request.url, 'https://example.invalid/v1/videos')
  assert.equal(request.method, 'POST')
  assert.equal(request.headers.Authorization, 'Bearer fixture')
  assert.equal(request.headers['Idempotency-Key'], 'task_public01')
  assert.equal(request.action, 'text_to_video')
  assert.deepEqual(request.body, {
    model: 'minimax_h3', prompt: 'Fixture', seconds: 6, workflow_id: 'text-to-video', output: { ratio: '768p-9x16' },
  })
  assert.deepEqual(plugin.extractUsage(ctx), { seconds: 6 })
  assert.equal(plugin.extractUsage({ ...ctx, usagePurpose: 'billing_ratios' }), null)
  assert.equal(plugin.extractUsageOnComplete(), null)
})

test('base URL variants all resolve to the same upstream prefix', () => {
  for (const baseUrl of ['https://example.invalid', 'https://example.invalid/v1', 'https://example.invalid/draw/api/v1/']) {
    assert.equal(plugin.buildSubmitRequest({ ...driver(), baseUrl }).url, 'https://example.invalid/v1/videos')
  }
  assert.throws(() => plugin.buildSubmitRequest({ ...driver(), baseUrl: '' }), /访问地址/)
})

for (const [resolution, frames, references, none] of [
  ['480p', 'fl2v', 'multi-reference', 'text-to-video'],
  ['768p', 'fl2v', 'multi-reference', 'text-to-video'],
  ['1080p', 'fl2v', 'multi-reference', 'text-to-video'],
  ['2k', 'cf-fl2v', 'cf-multi-reference', 'cf-multi-reference'],
  ['4k', 'cf-fl2v', 'cf-multi-reference', 'cf-multi-reference'],
]) {
  test(`${resolution} is pinned by the sales model and selects the matching workflow`, () => {
    const model = `H3-Video-${resolution.toUpperCase()}`
    const text = plugin.buildSubmitRequest(driver({}, model)).body
    assert.equal(text.output.ratio, `${resolution}-16x9`)
    assert.equal(text.workflow_id, none)
    const frame = plugin.buildSubmitRequest(driver({ images: [image, image] }, model)).body
    assert.equal(frame.workflow_id, frames)
    assert.deepEqual(frame.references.map(x => x.role), ['first_frame', 'last_frame'])
    const ref = plugin.buildSubmitRequest(driver({ metadata: { reference_images: [image] } }, model)).body
    assert.equal(ref.workflow_id, references)
    assert.deepEqual(ref.references, [{ type: 'image', role: 'reference', url: image }])
    const other = resolution === '480p' ? '1080p' : '480p'
    assert.throws(() => decode({ resolution: other }, model), /分辨率/)
    assert.throws(() => decode({ output: { ratio: `${other}-16x9` } }, model), /分辨率/)
  })
}

test('unqualified sales names stay at 768p and cannot buy another tier through parameters', () => {
  assert.equal(plugin.buildSubmitRequest(driver({}, 'minimax-h3')).body.output.ratio, '768p-16x9')
  assert.equal(plugin.buildSubmitRequest(driver({ resolution: '768p' }, 'minimax-h3')).body.output.ratio, '768p-16x9')
  assert.throws(() => decode({ resolution: '1080p' }, 'minimax-h3'), /模型名称/)
  assert.throws(() => decode({ size: '4k' }, 'minimax-h3'), /模型名称/)
  assert.throws(() => decode({}, 'h3-1080p', 'minimax_h3-03-480p'), /模型映射/)
  assert.equal(plugin.buildSubmitRequest(driver({}, 'h3', 'minimax_h3-03-1080p')).body.output.ratio, '1080p-16x9')
  assert.equal(plugin.buildSubmitRequest(driver({}, 'h3-480p', 'minimax_h3-03')).body.model, 'minimax_h3-03')
  assert.equal(plugin.buildSubmitRequest(driver({}, 'h3-480p', 'dmc-minimax-h3')).body.model, 'minimax_h3')
})

for (const value of [0, 3, 16, -1, 4.5, true, [], {}, ' ', 'Infinity', '5s', Number.MAX_VALUE]) {
  test(`invalid duration ${JSON.stringify(value)} cannot become a billing quantity`, () => {
    assert.throws(() => decode({ duration: value }), /视频时长/)
  })
}

test('duration aliases must agree and every hook rejects a bypassed billing quantity', () => {
  assert.equal(plugin.extractUsage(driver({})).seconds, 5)
  assert.equal(plugin.extractUsage(driver({ duration: 15, seconds: '15' })).seconds, 15)
  assert.throws(() => decode({ duration: 5, seconds: 6 }), /不一致/)
  assert.throws(() => decode({ seconds: 5, metadata: { seconds: 15 } }), /不一致/)
  const ctx = driver()
  for (const hook of [plugin.buildSubmitRequest, plugin.extractUsage]) {
    assert.throws(() => hook({ ...ctx, requestBody: { prompt: 'Fixture', duration: 99999 } }), /视频时长/)
    assert.throws(() => hook({ ...ctx, model: 'h3-480p', requestBody: { prompt: 'Fixture', resolution: '4k' } }), /分辨率/)
  }
})

test('ratios, sizes, and upstream output selectors normalize to one upstream output id', () => {
  const ratio = value => plugin.buildSubmitRequest(driver(value, 'h3-1080p')).body.output.ratio
  assert.equal(ratio({ aspect_ratio: '21:9' }), '1080p-21x9')
  assert.equal(ratio({ size: '1920x1080' }), '1080p-16x9')
  assert.equal(ratio({ size: '1088x1920' }), '1080p-9x16')
  assert.equal(ratio({ size: '3360x1440' }), '1080p-21x9')
  assert.equal(ratio({ size: '1080p', ratio: '3:2' }), '1080p-3x2')
  assert.equal(ratio({ output: { ratio: '1080p-2x3' } }), '1080p-2x3')
  for (const input of [{ ratio: 'adaptive' }, { ratio: '5:4' }, { size: '1000x999' }, { size: 'wide' },
    { ratio: '16:9', aspect_ratio: '9:16' }, { output: { ratio: '16:9' } }, { size: '0x0' }]) {
    assert.throws(() => decode(input), Error, JSON.stringify(input))
  }
})

for (const input of [
  { prompt: '' },
  { images: [image, image, image] },
  { metadata: { last_frame_image: image } },
  { metadata: { first_frame_image: image, reference_images: [image] } },
  { metadata: { reference_images: Array(10).fill(image) } },
  { videos: Array(4).fill('https://example.invalid/v.mp4') },
  { metadata: { reference_audios: Array(4).fill('https://example.invalid/a.mp3') } },
  { metadata: { reference_images: Array(9).fill(image), reference_videos: Array(3).fill('v'), reference_audios: ['a'] } },
  { media: [{ type: 'image_url', role: 'mask', image_url: image }] },
  { media: [{ role: 'reference_image', url: '' }] },
  { references: [{ type: 'file', url: image }] },
  { references: [{ type: 'video', role: 'first_frame', url: 'v' }] },
  { references: [{ type: 'image', url: image }], media: [{ role: 'reference_image', url: image }] },
  { metadata: 'bad' },
  { workflow_id: 'fl2v' },
  { prompt_enhance: 'yes' },
]) {
  test(`reject unsupported or conflicting input ${JSON.stringify(input).slice(0, 90)}`, () => {
    assert.throws(() => decode(input))
  })
}

test('typed media, upstream-style references, and prompt enhancement translate to upstream references', () => {
  const typed = plugin.buildSubmitRequest(driver({ metadata: { content: [
    { type: 'text', text: 'Typed prompt' },
    { type: 'image_url', role: 'reference_image', image_url: { url: image } },
    { type: 'video_url', video_url: 'https://example.invalid/v.mp4' },
    { type: 'audio_url', role: 'reference_audio', audio_url: 'https://example.invalid/a.mp3' },
  ] }, prompt_enhance: 'false' })).body
  assert.equal(typed.prompt, 'Typed prompt')
  assert.equal(typed.workflow_id, 'multi-reference')
  assert.equal(typed.prompt_enhance, false)
  assert.deepEqual(typed.references.map(x => [x.type, x.role]), [['image', 'reference'], ['video', 'reference'], ['audio', 'reference']])
  const native = plugin.buildSubmitRequest(driver({ workflow_id: 'fl2v', references: [
    { type: 'image', role: 'first_frame', url: image }, { type: 'image', role: 'last_frame', url: image },
  ] })).body
  assert.equal(native.workflow_id, 'fl2v')
  assert.equal(plugin.buildSubmitRequest(driver({ images: [image] })).action, 'image_to_video')
  assert.equal(plugin.buildSubmitRequest(driver({ metadata: { reference_audios: ['https://example.invalid/a.mp3'] } })).action, 'reference_to_video')
})

test('multipart uploads become bounded data-URL placeholders without reading file bytes', () => {
  const decoded = plugin.protocols.openai_video.decodeRequest({
    model: 'h3-2k',
    body: { kind: 'multipart', fields: { prompt: ['Fixture'], seconds: ['4'], output: ['{"ratio":"2k-1x1"}'] }, files: [
      { ref: 'request_file:first_frame', field: 'first_frame', mimeType: 'image/png' },
      { ref: 'request_file:last_frame', field: 'last_frame', mimeType: 'image/jpeg' },
    ] },
  })
  const body = plugin.buildSubmitRequest({ ...driver(), model: 'h3-2k', requestBody: decoded.requestBody }).body
  assert.equal(body.workflow_id, 'cf-fl2v')
  assert.equal(body.output.ratio, '2k-1x1')
  assert.deepEqual(body.references, [
    { type: 'image', role: 'first_frame', url: { __fileRef: 'request_file:first_frame', encoding: 'dataUrl', maxBytes: 31457280 } },
    { type: 'image', role: 'last_frame', url: { __fileRef: 'request_file:last_frame', encoding: 'dataUrl', maxBytes: 31457280 } },
  ])
  const refs = plugin.protocols.openai_video.decodeRequest({
    model: 'h3-480p',
    body: { kind: 'multipart', fields: { prompt: ['Fixture'], metadata: ['{"reference_images":["' + image + '"]}'] }, files: [
      { ref: 'request_file:reference_videos', field: 'reference_videos[]', mimeType: 'video/mp4' },
      { ref: 'request_file:audio', field: 'audio', mimeType: 'audio/mpeg' },
    ] },
  }).requestBody
  assert.deepEqual(refs.references.map(x => [x.type, typeof x.url === 'string' ? x.url : x.url.maxBytes]),
    [['image', image], ['video', 52428800], ['audio', 15728640]])
  for (const files of [
    [{ ref: 'request_file:image', field: 'image', mimeType: 'video/mp4' }],
    [{ ref: 'request_file:mask', field: 'mask', mimeType: 'image/png' }],
  ]) {
    assert.throws(() => plugin.protocols.openai_video.decodeRequest({ model: 'h3', body: { kind: 'multipart', fields: { prompt: ['x'] }, files } }), /上传/)
  }
  assert.throws(() => plugin.protocols.openai_video.decodeRequest({ model: 'h3', body: { kind: 'multipart', fields: { prompt: ['a', 'b'] }, files: [] } }), /重复/)
})

test('submission and polling protect the task lifecycle and wait for the anonymous CDN link', () => {
  assert.deepEqual(plugin.parseSubmitResponse({}, { body: { id: 'task_up', status: 'queued' } }),
    { taskId: 'task_up', taskData: { id: 'task_up', status: 'queued' } })
  assert.equal(plugin.parseSubmitResponse({}, { body: { id: 'task_up', status: 'failed', error: { message: 'bad' } } }).immediate.status, 'FAILURE')
  assert.throws(() => plugin.parseSubmitResponse({}, { body: { error: { code: 'unsupported_duration', message: 'This variant supports 4–15 seconds' } } }), /4–15/)
  assert.equal(plugin.buildQueryRequest({ baseUrl: 'https://example.invalid/v1', taskId: 'id?&', apiKey: 'fixture' }).url,
    'https://example.invalid/v1/videos/id%3F%26')
  assert.deepEqual(plugin.parseTaskResult({ taskId: 'task_up' }, { id: 'task_up', status: 'queued', progress: 20 }), { status: 'QUEUED', progress: '20%' })
  assert.equal(plugin.parseTaskResult({}, { status: 'in_progress', progress: 0 }).progress, '1%')
  assert.equal(plugin.parseTaskResult({}, { status: 'in_progress', progress: 100 }).progress, '99%')
  assert.equal(plugin.parseTaskResult({}, { status: 'cancelling' }).status, 'UNKNOWN')
  assert.equal(plugin.parseTaskResult({}, { error: { message: 'not visible' } }).status, 'UNKNOWN')
  assert.throws(() => plugin.parseTaskResult({ taskId: 'a' }, { id: 'b', status: 'queued' }), /编号/)
  assert.deepEqual(plugin.parseTaskResult({}, { status: 'failed', error: { code: 'upstream_failed', message: '原始错误' } }),
    { status: 'FAILURE', progress: '100%', reason: 'upstream_failed: 原始错误' })

  const pending = { id: 'task_up', status: 'completed', url: 'https://example.invalid/v1/videos/task_up/content', content_url: '/v1/videos/task_up/content' }
  assert.deepEqual(plugin.parseTaskResult({ state: null }, pending), { status: 'IN_PROGRESS', progress: '99%', state: { linkWaitPolls: 1 } })
  assert.equal(plugin.parseTaskResult({ state: { linkWaitPolls: 59 } }, pending).status, 'IN_PROGRESS')
  assert.equal(plugin.parseTaskResult({ state: { linkWaitPolls: 60 } }, pending).status, 'FAILURE')
  assert.deepEqual(plugin.parseTaskResult({ state: { linkWaitPolls: 3 } }, { ...pending, url: cdn, video_url: cdn }),
    { status: 'SUCCESS', progress: '100%', url: cdn })
})

test('artifacts use only the anonymous CDN link and never send channel credentials', () => {
  const data = { id: 'task_up', status: 'completed', url: cdn, video_url: cdn }
  assert.deepEqual(plugin.listArtifacts({ status: 'SUCCESS', data }), [{ key: 'video', type: 'video', mimeType: 'video/mp4' }])
  assert.deepEqual(plugin.listArtifacts({ status: 'SUCCESS', data: { data } }), [{ key: 'video', type: 'video', mimeType: 'video/mp4' }])
  assert.deepEqual(plugin.listArtifacts({ status: 'IN_PROGRESS', data }), [])
  assert.deepEqual(plugin.listArtifacts({ status: 'SUCCESS', data: { status: 'completed', url: 'https://example.invalid/v1/videos/x/content' } }), [])
  assert.deepEqual(plugin.buildContentRequest({ artifactKey: 'video', data, clientRequest: { method: 'HEAD' } }),
    { url: cdn, method: 'HEAD', credentialless: true })
  assert.throws(() => plugin.buildContentRequest({ artifactKey: 'audio', data, clientRequest: { method: 'GET' } }), /视频资源/)
  const output = plugin.protocols.openai_video.render({}, {
    task_id: 'public', status: 'FAILURE', progress: '100%', updated_at: 5, fail_reason: 'x',
    properties: { origin_model_name: 'h3-1080p' },
  })
  assert.deepEqual(output.error, { code: 'video_task_failed', message: 'x' })
  assert.equal(output.completed_at, 5)
  assert.equal(output.model, 'h3-1080p')
})
