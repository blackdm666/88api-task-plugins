import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import * as plugin from '../plugins/xm-video/plugin.js'
import * as old from './fixtures/xm-video-3.0.3.js'

const refs = n => Array(n).fill('https://example.invalid/media')
const models = [
  ...['480p', '720p', '1080p'].flatMap(q => [`wan3.0-video-${q}`, `SD2.0 ${q.toUpperCase()}`, `SD2.5 ${q.toUpperCase()}`]),
  ...['480p', '720p'].map(q => `seedance-2.0-mini-${q}`),
  ...['720p', '1080p', '2k', '4k'].map(q => `kling-3.0-turbo-${q}`),
  'Seedance-2.5-720p官方版', 'Seedance-2.0-720p官方版', 'Seedance-2.0-fast-720p官方版', 'minimax-h3-768p',
]
const decode = (input, model = 'SD2.5 720P') => plugin.decodeRequest({
  model, body: { kind: 'json', value: { prompt: 'Fixture', ratio: '16:9', ...input } },
})

for (const model of models) {
  test(`${model}: duration, ratio and seed guidance`, () => {
    assert.throws(() => decode({ duration: 4.5 }, model), /视频时长请输入整数秒数/)
    assert.throws(() => decode({ duration: -1 }, model), /视频时长需在 4 到 (15|30) 秒之间/)
    assert.throws(() => decode({ ratio: 'invalid' }, model), /当前模型不支持该画幅比例，请选择：/)
    assert.throws(() => decode({ seed: '1' }, model), /随机种子必须是整数/)
  })
}

test('prompt and reference limits give actionable model-specific guidance', () => {
  assert.throws(() => decode({ prompt: '', images: refs(1) }), /当前模型需要提示词/)
  assert.throws(() => decode({ prompt: '' }, 'SD2.0 720P'), /请输入提示词，或添加/)
  assert.doesNotThrow(() => decode({ prompt: '', images: refs(1) }, 'SD2.0 720P'))
  assert.throws(() => decode({ prompt: '字'.repeat(2001) }, 'kling-3.0-turbo-720p'), /2000 个字符以内/)
  assert.throws(() => decode({ images: refs(31) }), /参考图片.*30 张/)
  assert.throws(() => decode({ videos: refs(11) }), /参考视频.*10 个/)
  assert.throws(() => decode({ audios: refs(11) }), /参考音频.*10 段/)
  assert.throws(() => decode({ images: refs(9), videos: refs(3), audios: refs(1) }, 'SD2.0 720P'), /合计最多 12 个/)
  assert.throws(() => decode({ audios: refs(1) }, 'kling-3.0-turbo-720p'), /不支持参考音频/)
  assert.throws(() => decode({ audios: refs(1) }, 'minimax-h3-768p'), /至少同时添加/)
  assert.throws(() => decode({ firstFrame: refs(1)[0], images: refs(1) }), /首尾帧不能与普通参考/)
  assert.throws(() => decode({ lastFrame: refs(1)[0] }), /请先提供首帧/)
  assert.throws(() => decode({ images: refs(30), firstFrame: refs(1)[0] }, 'kling-3.0-turbo-720p'), /含首尾帧/)
  for (const [field, label] of [['images', '参考图片'], ['videos', '参考视频'], ['audios', '参考音频']]) {
    assert.throws(() => decode({ [field]: [{}] }), new RegExp(`${label}内容为空或格式无效`))
  }
})

test('audio, metadata, callback and multipart errors are localized', () => {
  assert.throws(() => decode({ generateAudio: 'false' }), /音频开关参数无效/)
  assert.throws(() => decode({ generateAudio: false }, 'wan3.0-video-720p'), /不支持音频开关/)
  assert.throws(() => decode({ metadata: '[' }), /metadata 参数格式不正确/)
  assert.throws(() => decode({ metadata: [] }), /metadata 参数格式不正确/)
  assert.throws(() => plugin.buildSubmitRequest({ model: 'SD2.5 720P', requestBody: { metadata: '[' } }), /metadata 参数格式不正确/)
  assert.throws(() => decode({ callback_url: 'https://example.invalid/callback' }), /移除 callback_url/)
  assert.throws(() => plugin.decodeRequest({}), /请求格式不正确/)
  assert.throws(() => plugin.decodeRequest({ body: { kind: 'json', value: [] } }), /JSON 对象/)
  const multipart = body => plugin.decodeRequest({ model: 'SD2.5 720P', body: { kind: 'multipart', ...body } })
  assert.throws(() => multipart({ fields: { prompt: ['a', 'b'] } }), /参数重复提交/)
  assert.throws(() => multipart({ fields: { images: ['['] } }), /有效的 JSON/)
  assert.throws(() => multipart({ files: [{ field: 'wrong' }] }), /仅支持一个参考文件/)
  assert.throws(() => multipart({ fields: { images: ['["https://example.invalid/i"]'] }, files: [{ field: 'input_reference' }] }), /不能与图片参数同时使用/)
})

test('task errors preserve provider evidence and avoid duplicate submission advice', () => {
  assert.throws(() => plugin.parseSubmitResponse({}, { body: {} }), /勿重复提交/)
  assert.match(plugin.parseTaskResult({}, { status: 'unknown' }).reason, /无需重新提交/)
  assert.match(plugin.parseTaskResult({}, { status: 'completed' }).reason, /未返回视频地址/)
  assert.match(plugin.parseTaskResult({}, { status: 'failed' }).reason, /视频生成失败/)
  assert.throws(() => plugin.buildContentRequest({ artifactKey: 'video', data: {} }), /视频结果暂不可用/)
  const provider = 'fixture upstream validation: unsupported media'
  assert.equal(plugin.parseTaskResult({}, { status: 'failed', error: { message: provider } }).reason, provider)
  assert.throws(() => plugin.parseSubmitResponse({}, { body: { status: 'failed', error: { message: provider } } }), { message: provider })
  assert.equal(plugin.protocols.openai_video.render({}, { status: 'FAILURE', fail_reason: provider }).error.message, provider)
  assert.match(plugin.protocols.openai_video.render({}, { status: 'FAILURE' }).error.message, /视频生成失败/)
})

test('valid requests, billing and task results are identical to deployed 3.0.3', async () => {
  // Archived 3.0.3 from source commit 7753c2b; usable on shallow CI checkouts.
  const oldSource = (await readFile(new URL('./fixtures/xm-video-3.0.3.js', import.meta.url), 'utf8')).replace(/\r\n/g, '\n')
  assert.equal(createHash('sha256').update(oldSource).digest('hex'), '9438e4d4e6cdce14093e26f0b57262afdbb45b02c995c36329997a8e3dae95fc')
  for (const model of models) {
    for (const input of [
      { prompt: 'Fixture', duration: 5, size: '1280x720' },
      { prompt: 'Fixture', duration: 5, ratio: '9:16', images: refs(1) },
    ]) {
      const ctx = { model, body: { kind: 'json', value: input } }
      const decoded = plugin.decodeRequest(ctx)
      assert.deepEqual(decoded, old.decodeRequest(ctx))
      const driver = { model, requestBody: decoded.requestBody, baseUrl: 'https://example.invalid', apiKey: 'fixture' }
      if (model.startsWith('SD2.5 ')) driver.upstreamModel = 'lltai-vs-2.5'
      assert.deepEqual(plugin.buildSubmitRequest(driver), old.buildSubmitRequest(driver))
      assert.deepEqual(plugin.extractUsage(driver), old.extractUsage(driver))
    }
  }
  for (const status of ['pending', 'processing', 'completed', 'failed', 'cancelled']) {
    const body = { status, progress: 1, result: 'https://example.invalid/video.mp4', error: { message: 'fixture failure' } }
    assert.deepEqual(plugin.parseTaskResult({}, body), old.parseTaskResult({}, body))
  }
})
