import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import * as plugin from '../plugins/minimax-h3/plugin.js'
import * as old from './fixtures/minimax-h3-2.0.0.js'

const refs = n => Array(n).fill('https://example.invalid/media')
const driver = input => ({
  model: 'minimax-h3-768p', upstreamModel: 'MiniMax-H3',
  baseUrl: 'https://example.invalid/', apiKey: 'fixture', publicTaskId: 'public-fixture',
  requestBody: { prompt: 'Fixture', ...input },
})
const content = items => ({ metadata: { content: [{ type: 'text', text: 'Fixture' }, ...items] } })
const submit = input => plugin.buildSubmitRequest(driver(input))
const decode = body => plugin.protocols.openai_video.decodeRequest({ model: 'minimax-h3-768p', body })
const json = input => ({ kind: 'json', value: { prompt: 'Fixture', ...input } })

for (const [name, input, message] of [
  ['missing prompt', { prompt: '' }, '请输入一段非空提示词；每次请求只能包含一段提示词。'],
  ['empty text', { metadata: { content: [{ type: 'text', text: ' ' }] } }, '提示词不能为空，请输入视频内容描述。'],
  ['duplicate text', content([{ type: 'text', text: 'Second' }]), '请输入一段非空提示词；每次请求只能包含一段提示词。'],
  ['duration', { duration: 1.5 }, '视频时长需为 1 到 15 秒之间的整数，请调整后提交。'],
  ['resolution', { resolution: '1080p' }, '当前模型仅支持 768P 分辨率，请选择 768P。'],
  ['ratio', { ratio: 'auto' }, '当前模型不支持该画幅比例，请选择：adaptive、21:9、16:9、4:3、1:1、3:4、9:16。'],
  ['adaptive without visual', { ratio: 'adaptive' }, '自适应比例需要图片或视频，请添加视觉素材，或选择具体画幅比例。'],
  ['too many frames', { images: refs(3) }, '首尾帧模式最多支持 2 张图片，请分别提供首帧和尾帧。'],
  ['duplicate first frame', { metadata: { firstFrame: refs(2) } }, '首帧和尾帧各最多 1 张，请删除重复图片。'],
  ['reference images', { metadata: { reference_images: refs(10) } }, '参考图片最多 9 张，请减少后提交。'],
  ['reference videos', { videos: refs(4) }, '参考视频最多 3 个，请减少后提交。'],
  ['reference audios', { metadata: { reference_audios: refs(4) } }, '参考音频最多 3 段，请减少后提交。'],
  ['total media', { videos: refs(3), metadata: { reference_images: refs(9), reference_audios: refs(1) } }, '参考素材合计最多 12 个，请减少图片、视频或音频数量。'],
  ['mixed modes', { images: refs(1), videos: refs(1) }, '首尾帧不能与参考素材混用，请选择首尾帧模式或参考素材模式。'],
  ['missing image role', content([{ type: 'image_url', image_url: refs(1)[0] }, { type: 'image_url', image_url: refs(1)[0] }]), '多张图片需要指定用途，请标明首帧、尾帧或参考图片。'],
  ['image role', content([{ type: 'image_url', image_url: refs(1)[0], role: 'other' }]), '图片用途无效，请设置为首帧、尾帧或参考图片。'],
  ['video role', content([{ type: 'video_url', video_url: refs(1)[0], role: 'other' }]), '视频素材仅支持作为参考视频，请将用途设为 reference_video。'],
  ['audio role', content([{ type: 'audio_url', audio_url: refs(1)[0], role: 'other' }]), '音频素材仅支持作为参考音频，请将用途设为 reference_audio。'],
  ['empty image URL', { images: [' '] }, '图片地址不能为空，请提供有效的素材链接。'],
  ['invalid video', { videos: [42] }, '视频格式不正确，请提供素材链接或有效的文件引用。'],
  ['empty audio URL', { metadata: { reference_audios: [{ url: ' ' }] } }, '音频地址不能为空，请提供有效的素材链接。'],
  ['content array', { metadata: { content: {} } }, '素材列表格式不正确，metadata.content 必须是数组。'],
  ['content item', content([null]), '素材内容格式不正确，请使用包含类型和内容的对象。'],
  ['content type', content([{ type: 'other' }]), '不支持该素材类型，请使用文本、图片、视频或音频。'],
  ['media item', { media: [42] }, '素材条目格式不正确，请提供素材类型和链接。'],
  ['media role', { media: [{ type: 'other' }] }, '素材用途无效，请指定首帧、尾帧、参考图片、参考视频或参考音频。'],
]) {
  test(`DMC H3 guidance: ${name}`, () => {
    assert.throws(() => old.buildSubmitRequest(driver(input)))
    assert.throws(() => old.protocols.openai_video.decodeRequest({ model: 'minimax-h3-768p', body: json(input) }))
    assert.throws(() => submit(input), { message })
    assert.throws(() => decode(json(input)), { message })
  })
}

test('request format and service configuration provide actionable guidance', () => {
  assert.throws(() => plugin.buildSubmitRequest({ ...driver({}), baseUrl: '' }),
    { message: '视频服务尚未配置访问地址，请联系管理员。' })
  assert.throws(() => decode({ kind: 'none' }), /请使用 JSON 或 multipart/)
  assert.throws(() => decode({ kind: 'json', value: [] }), /JSON 对象/)
  assert.throws(() => decode({ kind: 'multipart', files: [{ field: 'input_reference' }] }), /公开访问的 HTTPS 链接/)
  assert.throws(() => decode({ kind: 'multipart', fields: { prompt: ['a', 'b'] } }),
    { message: '参数重复提交：prompt，请只保留一个值。' })
  for (const metadata of ['[', '[]', 'null', '"text"']) {
    assert.throws(() => decode({ kind: 'multipart', fields: { metadata: [metadata] } }), /metadata 参数格式不正确/)
  }
  assert.throws(() => plugin.buildSubmitRequest({
    ...driver({ duration: 0 }), upstreamModel: 'future-model',
  }), { message: '请明确填写视频时长，时长必须是正整数秒数。' })
})

test('prompt length is forwarded without a plugin-side cap', () => {
  const prompt = '字'.repeat(10000)
  const decoded = decode(json({ prompt }))
  assert.equal(decoded.requestBody.prompt, prompt)
})

test('missing service details use Chinese guidance without suggesting duplicate generation', () => {
  assert.throws(() => plugin.parseSubmitResponse({}, { body: {} }),
    { message: '视频服务未返回任务编号，请联系管理员确认是否已受理，勿重复提交。' })
  assert.throws(() => plugin.parseTaskResult({}, {}),
    { message: '暂未获取到视频任务信息，请稍后查询，无需重新提交生成。' })
  assert.deepEqual(plugin.parseTaskResult({}, { task: { status: 'new-state' } }), {
    status: 'UNKNOWN', reason: '暂时无法识别视频任务状态，请稍后查询，无需重新提交生成。',
  })
  for (const [status, message] of [
    ['failed', '视频生成失败，服务端未提供具体原因，请联系管理员。'],
    ['cancelled', '视频任务已取消。'],
  ]) {
    assert.deepEqual(plugin.parseTaskResult({}, { task: { status } }), {
      code: 0, status: 'FAILURE', progress: '100%', reason: message,
    })
  }
  assert.match(plugin.protocols.openai_video.render({}, { status: 'FAILURE' }).error.message, /视频生成失败/)
  assert.throws(() => plugin.buildContentRequest({ artifactKey: 'other' }), /未找到所请求的视频资源/)
  assert.throws(() => plugin.buildContentRequest({ artifactKey: 'video', data: {} }), /视频结果暂不可用/)
})

test('upstream error text and codes are not translated or rewritten', () => {
  for (const statusCode of [400, 401, 403, 408, 429, 500, 503]) {
    const body = { error: { type: 'provider_error', message: 'Exact upstream detail: 参数 invalid', http_code: statusCode } }
    assert.throws(() => plugin.parseSubmitResponse({}, { body }), { message: 'provider_error: Exact upstream detail: 参数 invalid' })
    if (statusCode === 408 || statusCode === 429 || statusCode >= 500) {
      assert.throws(() => plugin.parseTaskResult({}, body), { message: 'provider_error: Exact upstream detail: 参数 invalid' })
    } else {
      assert.deepEqual(plugin.parseTaskResult({}, body), old.parseTaskResult({}, body))
    }
  }
  for (const status of ['failed', 'cancelled']) {
    for (const error of [
      { code: 'provider_policy', message: 'Unmodified provider reason\nline two' },
      { message: 'Do not translate this failure' },
    ]) {
      const body = { task: { status, error } }
      assert.deepEqual(plugin.parseTaskResult({}, body), old.parseTaskResult({}, body))
    }
  }
  assert.equal(plugin.parseTaskResult({}, { task: { status: 'failed', error: { code: 'E_PROVIDER_42' } } }).reason,
    'E_PROVIDER_42: 视频生成失败，服务端未提供具体原因，请联系管理员。')
  const task = { status: 'FAILURE', fail_reason: 'provider_code: Keep upstream text intact' }
  assert.deepEqual(plugin.protocols.openai_video.render({}, task), withNeutralCode(old.protocols.openai_video.render({}, task)))
})

// 2.0.4: the public error code no longer names the upstream provider.
const withNeutralCode = output => output.error ? { ...output, error: { ...output.error, code: 'video_task_failed' } } : output

test('input download failures become guidance and links or host names never reach customers', () => {
  const download = 'download media: Get "https://cheapest-twist-example.trycloudflare.com/a1b2.png": net/http: timeout awaiting response headers'
  assert.deepEqual(plugin.parseTaskResult({}, { task: { status: 'failed', error: { code: 'input_download_failed', message: download } } }), {
    code: 0, status: 'FAILURE', progress: '100%', reason: 'input_download_failed: 素材下载超时，请检查素材链接可公开访问后重试。',
  })
  assert.equal(plugin.parseTaskResult({}, { task: { status: 'failed', error: { code: 'input_download_failed', message: 'download media: HTTP 404' } } }).reason,
    'input_download_failed: 素材下载失败，请检查素材链接可公开访问后重试。')
  assert.equal(plugin.parseTaskResult({}, { error: { type: 'input_download_failed', message: download, http_code: 400 } }).reason,
    'input_download_failed: 素材下载超时，请检查素材链接可公开访问后重试。')
  assert.throws(() => plugin.parseSubmitResponse({}, { body: { error: { type: 'bad_request', message: download } } }),
    { message: 'input_download_failed: 素材下载超时，请检查素材链接可公开访问后重试。' })
  const leaked = plugin.parseTaskResult({}, { task: { status: 'failed', error: { code: 'x', message: '处理失败 https://bucket.example-cdn.com/v.mp4?sig=1 请联系 ops.vendor-gateway.best' } } }).reason
  assert.doesNotMatch(leaked, /https?:|example-cdn|vendor-gateway/)
  assert.match(leaked, /^x: 处理失败/)
  // Historical tasks rendered through GET /v1/videos use the same filter.
  const rendered = plugin.protocols.openai_video.render({}, { status: 'FAILURE', fail_reason: 'input_download_failed: ' + download })
  assert.deepEqual(rendered.error, { code: 'video_task_failed', message: 'input_download_failed: 素材下载超时，请检查素材链接可公开访问后重试。' })
  assert.doesNotMatch(JSON.stringify(plugin.protocols.openai_video.render({}, { status: 'FAILURE' })), /dmc/i)
})

test('valid requests, identities, idempotency and usage match the 2.0.0 baseline', async () => {
  const source = (await readFile(new URL('./fixtures/minimax-h3-2.0.0.js', import.meta.url), 'utf8')).replace(/\r\n/g, '\n')
  assert.equal(createHash('sha256').update(source).digest('hex'), '265d05def143b2e16dd0b24dbdaa500ef23e3be032bad6d056c58148d725473c')
  const { version: _, usageSchema: { output_resolution: ____, ...usageSchema }, ...metadata } = plugin.meta
  const { version: __, usageExamples: ___, ...oldMetadata } = old.meta
  assert.deepEqual({ ...metadata, usageSchema }, oldMetadata)
  for (const model of ['MiniMax-H3', 'minimax-h3-768p', 'dmc-minimax-h3']) {
    for (const input of [
      { prompt: 'Fixture' },
      { prompt: '😀'.repeat(7000), duration: 1 },
      { prompt: 'Fixture', duration: 15, ratio: '9:16' },
      { prompt: 'Fixture', images: refs(2), ratio: 'adaptive' },
      { prompt: 'Fixture', metadata: { lastFrame: refs(1)[0] } },
      { prompt: 'Fixture', videos: refs(3), metadata: { reference_images: refs(9) } },
      { prompt: 'Fixture', metadata: { reference_images: refs(6), reference_audios: refs(3), reference_videos: refs(3) } },
      { prompt: 'Fixture', metadata: { firstFrame: { __fileRef: 'request_file:input_reference', encoding: 'dataUrl' } } },
    ]) {
      const ctx = { model, body: { kind: 'json', value: input } }
      const decoded = plugin.protocols.openai_video.decodeRequest(ctx)
      assert.deepEqual(decoded, old.protocols.openai_video.decodeRequest(ctx))
      const d = { ...driver({}), model, upstreamModel: model, requestBody: decoded.requestBody }
      assert.deepEqual(plugin.buildSubmitRequest(d), old.buildSubmitRequest(d))
      assert.deepEqual(plugin.extractUsage(d), { ...old.extractUsage(d), output_resolution: '768p' })
      assert.equal(plugin.buildSubmitRequest(d).headers['Idempotency-Key'], 'public-fixture')
      assert.equal(plugin.extractUsage({ ...d, usagePurpose: 'billing_ratios' }), null)
    }
  }
  const multipart = { model: 'minimax-h3-768p', body: { kind: 'multipart', fields: { prompt: ['Fixture'], seconds: ['15'], metadata: ['{"ratio":"4:3"}'] } } }
  assert.deepEqual(plugin.protocols.openai_video.decodeRequest(multipart), old.protocols.openai_video.decodeRequest(multipart))
  const generic = { ...driver({ duration: 22, ratio: '21:9', resolution: '1080p' }), upstreamModel: 'future-model' }
  assert.deepEqual(plugin.buildSubmitRequest(generic), old.buildSubmitRequest(generic))
  assert.deepEqual(plugin.extractUsage(generic), old.extractUsage(generic))
})

test('2.0.3+ publishes no model-square price examples', () => {
  assert.equal(plugin.meta.version, '2.1.0')
  assert.equal('usageExamples' in plugin.meta, false)
  assert.deepEqual(Object.keys(plugin.meta.usageSchema), ['seconds', 'output_resolution'])
})

// 2.1.0: the model square renders one price column per enum value.
test('H3 bills the output resolution tier and still sends the upstream spelling', () => {
  assert.deepEqual(plugin.meta.usageSchema.output_resolution, {
    enum: ['768p'],
    enumLabels: { '768p': { en: '768P', zh: '768P' } },
    description: { en: 'Output video resolution', zh: '输出视频分辨率' },
  })
  for (const input of [
    {}, { resolution: '768P' }, { resolution: '768p' }, { resolution: ' 768 ' },
    { size: '1366x768' }, { metadata: { resolution: '768P' } }, { metadata: { resolution: '768p' }, resolution: 'ignored' },
  ]) {
    const decoded = decode(json({ duration: 6, ...input }))
    // The request keeps the client's spelling; the host only checks keys named like usage fields.
    assert.deepEqual(decoded.requestBody, old.protocols.openai_video.decodeRequest({ model: 'minimax-h3-768p', body: json({ duration: 6, ...input }) }).requestBody)
    const d = { ...driver({}), requestBody: decoded.requestBody }
    assert.equal(plugin.buildSubmitRequest(d).body.resolution, '768P')
    assert.deepEqual(plugin.buildSubmitRequest(d).body, old.buildSubmitRequest(d).body)
    assert.deepEqual(plugin.extractUsage(d), { seconds: 6, output_resolution: '768p' })
  }
  // A sold name mapped to the H3 alias decodes generically, then bills the tier.
  const mapped = plugin.protocols.openai_video.decodeRequest({ model: 'dynamic-sale', body: json({ duration: 5, resolution: '768P' }) })
  assert.equal(mapped.requestBody.resolution, '768P')
  assert.deepEqual(plugin.extractUsage({ ...driver({}), model: 'dynamic-sale', upstreamModel: 'dmc-minimax-h3', requestBody: mapped.requestBody }),
    { seconds: 5, output_resolution: '768p' })
  for (const resolution of ['1080p', '480P', '4k']) {
    assert.throws(() => plugin.extractUsage({ ...driver({}), requestBody: { prompt: 'Fixture', resolution } }),
      { message: '当前模型仅支持 768P 分辨率，请选择 768P。' })
  }
  // Other upstream models keep forwarding the requested value unbilled.
  const generic = { ...driver({ duration: 7, resolution: '1080P' }), upstreamModel: 'future-model' }
  assert.equal(plugin.buildSubmitRequest(generic).body.resolution, '1080P')
  assert.deepEqual(plugin.extractUsage(generic), { seconds: 7 })
})

test('polling, terminal progress, download and historical task rendering stay compatible', () => {
  const ctx = { ...driver({}), taskId: 'upstream/id' }
  assert.deepEqual(plugin.buildQueryRequest(ctx), old.buildQueryRequest(ctx))
  const response = { body: { task_id: 'upstream-fixture', extra: 'preserved' } }
  assert.deepEqual(plugin.parseSubmitResponse({}, response), old.parseSubmitResponse({}, response))
  for (const status of ['queued', 'running', 'succeeded', 'failed', 'cancelled']) {
    for (const progress of [0, 0.4, 1]) {
      const body = { task: { status, progress, duration: 8, content: { url: 'https://example.invalid/video.mp4' }, error: { code: 'upstream', message: 'Unchanged detail' } } }
      assert.deepEqual(plugin.parseTaskResult({}, body), old.parseTaskResult({}, body))
      if (status === 'running') assert.ok(parseInt(plugin.parseTaskResult({}, body).progress) < 100)
      assert.deepEqual(plugin.extractUsageOnComplete({}, {}, body), old.extractUsageOnComplete({}, {}, body))
      const task = { status: 'SUCCESS', data: body }
      assert.deepEqual(plugin.listArtifacts(task), old.listArtifacts(task))
      for (const data of [body, { data: body }]) {
        for (const method of ['GET', 'HEAD']) {
          const contentCtx = { data, artifactKey: 'video', clientRequest: { method } }
          assert.deepEqual(plugin.buildContentRequest(contentCtx), old.buildContentRequest(contentCtx))
        }
      }
    }
  }
  for (const status of ['NOT_START', 'SUBMITTED', 'QUEUED', 'IN_PROGRESS', 'SUCCESS', 'FAILURE']) {
    const task = { task_id: 'historical-id', status, progress: '99%', created_at: 10, updated_at: 20, properties: { origin_model_name: 'minimax-h3-768p' }, fail_reason: 'upstream detail' }
    assert.deepEqual(plugin.protocols.openai_video.render({}, task), withNeutralCode(old.protocols.openai_video.render({}, task)))
  }
  // Do not turn an incomplete success payload into a new terminal/refund rule.
  const missingVideo = { task: { status: 'succeeded' } }
  assert.deepEqual(plugin.parseTaskResult({}, missingVideo), old.parseTaskResult({}, missingVideo))
})
