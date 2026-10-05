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
  assert.equal(plugin.meta.version, '1.1.1')
  assert.deepEqual(plugin.meta.requiredCapabilities, ['task-preflight@1'])
  assert.equal(plugin.meta.dynamicModels, true)
  assert.deepEqual(plugin.meta.models, [
    'doubao-seedance-2-0-mini-260615',
    'doubao-seedance-2-0-260128',
    'doubao-seedance-2-0-fast-260128',
    'doubao-seedance-2-5-260628',
  ])
  assert.deepEqual(plugin.meta.usageSchema.resolution.enum, ['480p', '720p', '1080p', '4k'])
  assert.deepEqual(plugin.meta.usageSchema.video_input.enum, ['none', 'present'])
  assert.equal(plugin.meta.usageSchema.upstreamUnits.unit, 'token')
  assert.deepEqual(plugin.meta.usageProfiles[0].schema.resolution.enum, ['480p', '720p'])
  assert.deepEqual(plugin.meta.usageProfiles[1].schema.resolution.enum, ['480p', '720p', '1080p', '4k'])
  assert.deepEqual(plugin.meta.usageProfiles[2].schema.resolution.enum, ['480p', '720p', '1080p'])
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

test('Seedance prompts have no plugin-side length cap', () => {
  const prompt = '字'.repeat(10000)
  const decoded = decode({ prompt })
  assert.equal(decoded.requestBody.content[0].text, prompt)
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

test('infers SDGO asset modes for asset and presigned tos sources', () => {
  const imageAsset = decode({
    content: [
      { type: 'text', text: 'Portrait fixture' },
      { type: 'image_url', role: 'reference_image', image_url: { url: 'tos://bucket/image.png' } },
    ],
  })
  assert.equal(imageAsset.requestBody.image_source_mode, 'asset')
  assert.equal(imageAsset.requestBody.content[1].image_url.url, 'tos://bucket/image.png')

  const videoAsset = decode({
    content: [
      { type: 'text', text: 'Video fixture' },
      { type: 'video_url', role: 'reference_video', video_url: { url: 'asset://video-asset-1' } },
    ],
  })
  assert.equal(videoAsset.requestBody.video_source_mode, 'asset')
  assert.equal(videoAsset.requestBody.content[1].video_url.url, 'asset://video-asset-1')

  const legacyFields = decode({
    referenceImages: ['asset://image-asset-1'],
    referenceVideos: ['tos://bucket/video.mp4'],
  })
  assert.equal(legacyFields.requestBody.image_source_mode, 'asset')
  assert.equal(legacyFields.requestBody.video_source_mode, 'asset')
})

test('preserves explicit SDGO media source modes and does not infer for HTTPS URLs', () => {
  const direct = decode({
    image_source_mode: 'direct_url',
    video_source_mode: 'direct_url',
    content: [
      { type: 'text', text: 'Direct fixture' },
      { type: 'image_url', role: 'reference_image', image_url: { url: image } },
      { type: 'video_url', role: 'reference_video', video_url: { url: video } },
    ],
  })
  assert.equal(direct.requestBody.image_source_mode, 'direct_url')
  assert.equal(direct.requestBody.video_source_mode, 'direct_url')

  const https = decode({
    content: [
      { type: 'text', text: 'HTTPS fixture' },
      { type: 'image_url', role: 'reference_image', image_url: { url: image } },
      { type: 'video_url', role: 'reference_video', video_url: { url: video } },
    ],
  })
  assert.equal(https.requestBody.image_source_mode, undefined)
  assert.equal(https.requestBody.video_source_mode, undefined)
})

test('keeps local image placeholders available for the host JSON inliner', () => {
  const decoded = plugin.decodeRequest({
    model: 'doubao-seedance-2-5-260628',
    body: {
      kind: 'json',
      value: {
        prompt: 'Local image fixture',
        image_source_mode: 'asset',
        content: [
          { type: 'text', text: 'Local image fixture' },
          {
            type: 'image_url',
            role: 'reference_image',
            image_url: { url: { __fileRef: 'request_file:image', encoding: 'dataUrl', mimeType: 'image/png' } },
          },
        ],
      },
    },
  })
  assert.deepEqual(decoded.requestBody.content[1].image_url.url, {
    __fileRef: 'request_file:image',
    encoding: 'dataUrl',
    mimeType: 'image/png',
  })
})

test('maps one local multipart image to a host file placeholder', () => {
  const decoded = plugin.decodeRequest({
    model: 'doubao-seedance-2-5-260628',
    body: {
      kind: 'multipart',
      fields: {
        prompt: ['Local multipart image'],
      },
      files: [{
        field: 'image',
        ref: 'request_file:image',
        filename: 'portrait.png',
        mimeType: 'image/png',
        size: 12,
      }],
    },
  })
  assert.deepEqual(decoded.requestBody.content[1].image_url.url, {
    __fileRef: 'request_file:image',
    encoding: 'dataUrl',
    mimeType: 'image/png',
  })
})

test('preflights local multipart images into the SDGO asset library', () => {
  const decoded = plugin.decodeRequest({
    model: 'doubao-seedance-2-5-260628',
    body: {
      kind: 'multipart',
      fields: { prompt: ['Local asset image'] },
      files: [{
        field: 'image',
        ref: 'request_file:image',
        filename: 'portrait.png',
        mimeType: 'image/png',
        size: 1234,
      }],
    },
  })
  const ctx = {
    ...decoded,
    baseUrl: 'https://sdgo.top',
    apiKey: 'fixture-key',
    files: [{
      ref: 'request_file:image',
      field: 'image',
      filename: 'portrait.png',
      mimeType: 'image/png',
      size: 1234,
    }],
  }
  const presign = plugin.buildPreflightRequest(ctx)
  assert.equal(presign.url, 'https://sdgo.top/v1/seedance/uploads/presign')
  assert.equal(presign.body.filename, 'portrait.png')
  assert.equal(presign.body.size, 1234)
  assert.equal(presign.body.content_type, 'image/png')
  const upload = plugin.buildUploadRequest({
    ...ctx,
    preflightResponse: {
      data: {
        source: 'tos://seedance/input/fixture.png',
        upload_url: 'https://sdgotop.tos-cn-beijing.volces.com/fixture.png?signature=fixture',
        headers: { 'Content-Type': 'image/png' },
      },
    },
  })
  assert.equal(upload.method, 'PUT')
  assert.equal(upload.credentialless, true)
  assert.equal(upload.bodyType, 'file')
  assert.equal(upload.fileRef, 'request_file:image')
  assert.deepEqual(upload.headers, { 'Content-Type': 'image/png' })
  const submitted = plugin.buildSubmitRequest({
    ...ctx,
    preflightResponse: {
      data: { source: 'tos://seedance/input/fixture.png' },
    },
  })
  assert.equal(submitted.body.image_source_mode, 'asset')
  assert.equal(submitted.body.content[1].image_url.url, 'tos://seedance/input/fixture.png')
})

test('does not fall back to an inline local image when the asset upload is incomplete', () => {
  const decoded = plugin.decodeRequest({
    model: 'doubao-seedance-2-5-260628',
    body: {
      kind: 'multipart',
      fields: { prompt: ['Local asset image'] },
      files: [{
        field: 'image',
        ref: 'request_file:image',
        filename: 'portrait.png',
        mimeType: 'image/png',
        size: 1234,
      }],
    },
  })
  const ctx = {
    ...decoded,
    baseUrl: 'https://sdgo.top',
    apiKey: 'fixture-key',
    files: [{
      ref: 'request_file:image',
      field: 'image',
      filename: 'portrait.png',
      mimeType: 'image/png',
      size: 1234,
    }],
  }
  assert.throws(
    () => plugin.buildSubmitRequest(ctx),
    /本地图片素材上传未完成/,
  )
})

test('rejects multiple local image files instead of mixing inline and asset modes', () => {
  const decoded = plugin.decodeRequest({
    model: 'doubao-seedance-2-5-260628',
    body: {
      kind: 'json',
      value: {
        prompt: 'Two local images',
        content: [
          { type: 'text', text: 'Two local images' },
          {
            type: 'image_url',
            role: 'reference_image',
            image_url: {
              url: { __fileRef: 'request_file:first', encoding: 'dataUrl', mimeType: 'image/png' },
            },
          },
          {
            type: 'image_url',
            role: 'reference_image',
            image_url: {
              url: { __fileRef: 'request_file:second', encoding: 'dataUrl', mimeType: 'image/png' },
            },
          },
        ],
      },
    },
  })
  assert.throws(
    () => plugin.buildPreflightRequest({
      ...decoded,
      apiKey: 'fixture-key',
      files: [
        { ref: 'request_file:first', filename: 'first.png', mimeType: 'image/png', size: 10 },
        { ref: 'request_file:second', filename: 'second.png', mimeType: 'image/png', size: 10 },
      ],
    }),
    /仅支持一个本地图片素材/,
  )
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

test('extracts completion token usage for every accepted terminal success status', () => {
  for (const status of ['succeeded', 'completed', 'success', 'done']) {
    assert.deepEqual(
      plugin.extractUsageOnComplete({}, {}, {
        status,
        usage: { completion_tokens: 216900 },
      }),
      { upstreamUnits: 216900 },
      `status=${status}`,
    )
  }
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

test('uses provider-selected duration for implicit Seedance 2.5 video editing', () => {
  const implicitEdit = decode({
    prompt: '编辑这段参考视频，保留人物并改变场景',
    duration: 4,
    referenceVideos: [video],
  })
  assert.equal(implicitEdit.requestBody.duration, 4)
  assert.equal(implicitEdit.requestBody.ratio, 'adaptive')
  const submitted = plugin.buildSubmitRequest({
    model: implicitEdit.model,
    upstreamModel: implicitEdit.model,
    requestBody: implicitEdit.requestBody,
    baseUrl: 'https://sdgo.top',
    apiKey: 'fixture',
  })
  assert.equal(submitted.body.duration, -1)

  const explicitAuto = decode({
    prompt: '根据这段视频继续创作',
    duration: 8,
    referenceVideos: [video],
    omniReferenceTaskType: 'auto',
  })
  assert.equal(explicitAuto.requestBody.duration, 8)
  const autoSubmit = plugin.buildSubmitRequest({
    model: explicitAuto.model,
    upstreamModel: explicitAuto.model,
    requestBody: explicitAuto.requestBody,
    baseUrl: 'https://sdgo.top',
    apiKey: 'fixture',
  })
  assert.equal(autoSubmit.body.duration, -1)

  const explicitReference = decode({
    prompt: '参考这段视频的动作节奏',
    duration: 8,
    referenceVideos: [video],
    omniReferenceTaskType: 'reference',
  })
  assert.equal(explicitReference.requestBody.duration, 8)
  const referenceSubmit = plugin.buildSubmitRequest({
    model: explicitReference.model,
    upstreamModel: explicitReference.model,
    requestBody: explicitReference.requestBody,
    baseUrl: 'https://sdgo.top',
    apiKey: 'fixture',
  })
  assert.equal(referenceSubmit.body.duration, 8)
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
