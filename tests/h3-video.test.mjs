import test from 'node:test'
import assert from 'node:assert/strict'
import * as plugin from '../plugins/h3-video/plugin.js'

const decode = (value, model = 'H3-Video') => plugin.protocols.openai_video.decodeRequest({
  model, body: { kind: 'json', value: { prompt: 'Fixture', ...value } },
})
const driver = (value = {}, upstreamModel = 'minimax_h3') => ({
  model: 'H3-Video', upstreamModel, baseUrl: 'https://example.invalid/', apiKey: 'fixture', publicTaskId: 'task_public01',
  requestBody: decode(value).requestBody,
})
const submit = (value, upstreamModel) => plugin.buildSubmitRequest(driver(value, upstreamModel))
const image = 'https://example.invalid/i.png'
const cdn = 'https://cdn.example.invalid/video.mp4?X-Amz-Signature=abc'

test('text-to-video builds the upstream request with the channel-mapped model and idempotency', () => {
  assert.equal(plugin.meta.key, 'h3-video')
  assert.equal(plugin.meta.name, 'H3-Video')
  const ctx = driver({ seconds: '6', resolution: '1080P', ratio: '9:16' })
  const request = plugin.buildSubmitRequest(ctx)
  assert.equal(request.url, 'https://example.invalid/v1/videos')
  assert.equal(request.method, 'POST')
  assert.equal(request.headers.Authorization, 'Bearer fixture')
  assert.equal(request.headers['Idempotency-Key'], 'task_public01')
  assert.equal(request.action, 'text_to_video')
  assert.deepEqual(request.body, {
    model: 'minimax_h3', prompt: 'Fixture', seconds: 6, workflow_id: 'text-to-video', output: { ratio: '1080p-9x16' },
  })
  assert.deepEqual(plugin.extractUsage(ctx), { seconds: 6, resolution: '1080p' })
  assert.equal(plugin.extractUsage({ ...ctx, usagePurpose: 'billing_ratios' }), null)
  assert.equal(plugin.extractUsageOnComplete(), null)
  assert.equal(submit({}, 'minimax_h3-03').body.model, 'minimax_h3-03')
  assert.equal(plugin.buildSubmitRequest({ ...ctx, upstreamModel: '' }).body.model, 'H3-Video')
})

test('omitted output uses the upstream catalogue first tier explicitly so billing matches', () => {
  const ctx = driver()
  assert.deepEqual(plugin.buildSubmitRequest(ctx).body.output, { ratio: '480p-16x9' })
  assert.deepEqual(plugin.extractUsage(ctx), { seconds: 5, resolution: '480p' })
})

test('base URL variants all resolve to the same upstream prefix', () => {
  for (const baseUrl of ['https://example.invalid', 'https://example.invalid/v1', 'https://example.invalid/draw/api/v1/']) {
    assert.equal(plugin.buildSubmitRequest({ ...driver(), baseUrl }).url, 'https://example.invalid/v1/videos')
  }
  assert.throws(() => plugin.buildSubmitRequest({ ...driver(), baseUrl: '' }), /访问地址/)
})

test('resolution and ratio come from the request; billed resolution always equals the sent output', () => {
  const output = value => [submit(value).body.output.ratio, plugin.extractUsage(driver(value)).resolution]
  assert.deepEqual(output({ output: { ratio: '2K-21x9' } }), ['2k-21x9', '2k'])
  assert.deepEqual(output({ size: '4k', aspect_ratio: '1:1' }), ['4k-1x1', '4k'])
  assert.deepEqual(output({ size: '1920x1080', resolution: '768p' }), ['768p-16x9', '768p'])
  assert.deepEqual(output({ size: '3360x1440', metadata: { resolution: '1080p' } }), ['1080p-21x9', '1080p'])
  assert.deepEqual(output({ resolution: '1080p', output: { ratio: '1080p-3x2' } }), ['1080p-3x2', '1080p'])
  for (const input of [{ resolution: '1080p', output: { ratio: '480p-16x9' } }, { resolution: '1080p', size: '2k' },
    { ratio: '16:9', aspect_ratio: '9:16' }, { output: { ratio: '16:9' } }, { size: '0x0' }]) {
    assert.throws(() => decode(input), Error, JSON.stringify(input))
  }
})

test('capabilities are left to the upstream instead of local allow-lists', () => {
  // Unpublished tiers/ratios/durations/media counts and workflow choices reach the upstream untouched.
  assert.equal(submit({ resolution: '720p', ratio: 'adaptive' }).body.output.ratio, '720p-adaptive')
  assert.equal(submit({ duration: 1 }).body.seconds, 1)
  assert.equal(submit({ seconds: 60 }).body.seconds, 60)
  assert.equal(submit({ metadata: { reference_images: Array(20).fill(image) } }).body.references.length, 20)
  assert.equal(submit({ workflow_id: 'fl2v' }).body.workflow_id, 'fl2v')
  assert.equal(submit({ prompt: '' }).body.prompt, undefined)
  const mixed = submit({ metadata: { first_frame_image: image, reference_images: [image] } }).body
  assert.deepEqual(mixed.references.map(x => x.role), ['first_frame', 'reference'])
})

for (const value of [0, -1, 4.5, true, [], {}, ' ', 'Infinity', '5s', 3601, Number.MAX_VALUE]) {
  test(`invalid duration ${JSON.stringify(value)} cannot become a billing quantity`, () => {
    assert.throws(() => decode({ duration: value }), /视频时长/)
  })
}

test('duration aliases must agree and every hook rejects a bypassed billing quantity', () => {
  assert.equal(plugin.extractUsage(driver({ duration: 15, seconds: '15' })).seconds, 15)
  assert.throws(() => decode({ duration: 5, seconds: 6 }), /不一致/)
  assert.throws(() => decode({ seconds: 5, metadata: { seconds: 15 } }), /不一致/)
  const ctx = driver()
  for (const hook of [plugin.buildSubmitRequest, plugin.extractUsage]) {
    assert.throws(() => hook({ ...ctx, requestBody: { prompt: 'Fixture', duration: 99999 } }), /视频时长/)
    assert.throws(() => hook({ ...ctx, requestBody: { prompt: 'Fixture', resolution: '4k', output: { ratio: '480p-16x9' } } }), /分辨率/)
  }
})

for (const [resolution, frames, references, none] of [
  ['480p', 'fl2v', 'multi-reference', 'text-to-video'],
  ['1080p', 'fl2v', 'multi-reference', 'text-to-video'],
  ['2k', 'cf-fl2v', 'cf-multi-reference', 'cf-multi-reference'],
  ['4k', 'cf-fl2v', 'cf-multi-reference', 'cf-multi-reference'],
]) {
  test(`${resolution} picks a default workflow from the supplied media`, () => {
    assert.equal(submit({ resolution }).body.workflow_id, none)
    const frame = submit({ resolution, images: [image, image] }).body
    assert.equal(frame.workflow_id, frames)
    assert.deepEqual(frame.references.map(x => x.role), ['first_frame', 'last_frame'])
    const ref = submit({ resolution, metadata: { reference_images: [image] } }).body
    assert.equal(ref.workflow_id, references)
    assert.deepEqual(ref.references, [{ type: 'image', role: 'reference', url: image }])
  })
}

test('typed content, upstream references and metadata extras translate without loss', () => {
  const ctx = driver({ prompt: undefined, prompt_enhance: 'false', metadata: { seed: 0, prompt_enhance: true, content: [
    { type: 'text', text: 'Typed prompt' },
    { type: 'image_url', role: 'reference_image', image_url: { url: image } },
    { type: 'video_url', video_url: 'https://example.invalid/v.mp4' },
    { type: 'audio_url', role: 'reference_audio', audio_url: 'https://example.invalid/a.mp3' },
  ] } })
  const typed = plugin.buildSubmitRequest(ctx).body
  assert.equal(typed.prompt, 'Typed prompt')
  assert.equal(typed.workflow_id, 'multi-reference')
  // Top-level fields win over forwarded metadata; untouched extras survive both decode passes.
  assert.equal(typed.prompt_enhance, false)
  assert.equal(typed.seed, 0)
  assert.deepEqual(typed.references.map(x => [x.type, x.role]), [['image', 'reference'], ['video', 'reference'], ['audio', 'reference']])
  const native = submit({ references: [
    { type: 'image', role: 'first_frame', url: image }, { type: 'image', role: 'last_frame', url: image, extra: 'kept' },
  ] }).body
  assert.equal(native.workflow_id, 'fl2v')
  assert.equal(native.references[1].extra, 'kept')
  assert.equal(submit({ images: [image] }).action, 'image_to_video')
  assert.equal(submit({ metadata: { reference_audios: ['https://example.invalid/a.mp3'] } }).action, 'reference_to_video')
  for (const input of [{ metadata: 'bad' }, { references: [{ url: image }] }, { media: [{ role: 'mask', url: image }] },
    { metadata: { reference_images: [''] } }, { metadata: { content: [{ type: 'text', text: 'Other' }] } }]) {
    assert.throws(() => decode(input), Error, JSON.stringify(input))
  }
})

test('multipart uploads become data-URL placeholders without reading file bytes', () => {
  const decoded = plugin.protocols.openai_video.decodeRequest({
    model: 'H3-Video',
    body: { kind: 'multipart', fields: { prompt: ['Fixture'], seconds: ['4'], output: ['{"ratio":"2k-1x1"}'] }, files: [
      { ref: 'request_file:first_frame', field: 'first_frame', mimeType: 'image/png' },
      { ref: 'request_file:last_frame', field: 'last_frame', mimeType: 'image/jpeg' },
    ] },
  })
  const ctx = { ...driver(), requestBody: decoded.requestBody }
  const body = plugin.buildSubmitRequest(ctx).body
  assert.equal(body.workflow_id, 'cf-fl2v')
  assert.equal(body.output.ratio, '2k-1x1')
  assert.deepEqual(plugin.extractUsage(ctx), { seconds: 4, resolution: '2k' })
  assert.deepEqual(body.references, [
    { type: 'image', role: 'first_frame', url: { __fileRef: 'request_file:first_frame', encoding: 'dataUrl' } },
    { type: 'image', role: 'last_frame', url: { __fileRef: 'request_file:last_frame', encoding: 'dataUrl' } },
  ])
  const refs = plugin.protocols.openai_video.decodeRequest({
    model: 'H3-Video',
    body: { kind: 'multipart', fields: { prompt: ['Fixture'], metadata: ['{"reference_images":["' + image + '"],"seed":1}'] }, files: [
      { ref: 'request_file:reference_videos', field: 'reference_videos[]', mimeType: 'video/mp4' },
      { ref: 'request_file:audio', field: 'audio', mimeType: 'audio/mpeg' },
    ] },
  }).requestBody
  assert.deepEqual(refs.references.map(x => [x.type, typeof x.url === 'string' ? x.url : x.url.__fileRef]),
    [['image', image], ['video', 'request_file:reference_videos'], ['audio', 'request_file:audio']])
  assert.equal(plugin.buildSubmitRequest({ ...driver(), requestBody: refs }).body.seed, 1)
  for (const files of [
    [{ ref: 'request_file:image', field: 'image', mimeType: 'video/mp4' }],
    [{ ref: 'request_file:mask', field: 'mask', mimeType: 'image/png' }],
  ]) {
    assert.throws(() => plugin.protocols.openai_video.decodeRequest({ model: 'H3-Video', body: { kind: 'multipart', fields: { prompt: ['x'] }, files } }), /上传/)
  }
  assert.throws(() => plugin.protocols.openai_video.decodeRequest({ model: 'H3-Video', body: { kind: 'multipart', fields: { prompt: ['a', 'b'] }, files: [] } }), /重复/)
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
  const leaked = plugin.parseTaskResult({}, { status: 'failed', error: { code: 'x', message: '下载失败 https://bucket.s3.example-cdn.com/v.mp4?sig=1 请联系 support.upstream-vendor.best' } })
  assert.doesNotMatch(leaked.reason, /https?:|example-cdn|upstream-vendor/)
  assert.match(leaked.reason, /下载失败/)
  assert.equal(plugin.parseTaskResult({}, { status: 'failed', error: { message: 'https://only.example.com/x' } }).reason.includes('example'), false)

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
    properties: { origin_model_name: 'H3-Video' },
  })
  assert.deepEqual(output.error, { code: 'video_task_failed', message: 'x' })
  assert.equal(output.completed_at, 5)
  assert.equal(output.model, 'H3-Video')
})
