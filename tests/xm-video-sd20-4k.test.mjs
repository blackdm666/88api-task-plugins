import assert from 'node:assert/strict'
import test from 'node:test'
import * as plugin from '../plugins/xm-video/plugin.js'

const model = 'SD2.0 4K'
const refs = n => Array(n).fill('https://example.invalid/media')

function submit(input = {}, name = model, upstreamModel = 'lltai-vs-2.0') {
  const decoded = plugin.decodeRequest({
    model: name,
    body: { kind: 'json', value: { prompt: 'Protocol fixture', ...input } },
  })
  const ctx = {
    model: name, upstreamModel, requestBody: decoded.requestBody,
    baseUrl: 'https://example.invalid/v1', apiKey: 'fixture',
  }
  return { decoded, body: plugin.buildSubmitRequest(ctx).body, usage: plugin.extractUsage(ctx) }
}

test('SD2.0 4K: fixed upstream 4K quality and frozen billing quantity', () => {
  for (const duration of [4, 5, 10, 15]) {
    const { body, usage } = submit({
      duration, resolution: '480p', quality: '1080p', metadata: { resolution: '720p', vquality: '480p' },
    })
    assert.equal(body.model, 'lltai-vs-2.0')
    assert.equal(body.resolution, '4K')
    assert.equal(body.duration, duration)
    assert.equal(usage.seconds, duration)
  }
  const { decoded, body, usage } = submit()
  assert.equal(decoded.model, model)
  assert.equal(decoded.requestBody.duration, 5)
  assert.equal(body.duration, 5)
  assert.equal(usage.seconds, 5)
  assert.equal(body.ratio, '1:1')
  assert.equal(submit({ seconds: '12' }).usage.seconds, 12)
})

test('SD2.0 4K: duration and ratio limits match the other SD2.0 tiers', () => {
  for (const duration of [3, 16, 30, 4.5, -1]) {
    assert.throws(() => submit({ duration }), /视频时长/)
  }
  assert.throws(() => submit({ duration: 16 }), /视频时长需在 4 到 15 秒之间/)
  for (const ratio of ['1:1', '21:9', '16:9', '9:16', '3:4', '4:3']) {
    assert.equal(submit({ ratio }).body.ratio, ratio)
  }
  assert.equal(submit({ size: '1920x1080' }).body.ratio, '16:9')
  assert.throws(() => submit({ ratio: 'auto' }), /当前模型不支持自动比例/)
  assert.throws(() => submit({ ratio: '2:1' }), /当前模型不支持该画幅比例，请选择：16:9、9:16、1:1、4:3、3:4、21:9/)
})

test('SD2.0 4K: reference limits, frame exclusivity, audio switch and promptless media', () => {
  const full = { referenceImages: refs(9), referenceVideos: refs(3) }
  assert.deepEqual(submit(full).body.referenceImages, full.referenceImages)
  assert.throws(() => submit({ images: refs(10) }), /参考图片.*9 张/)
  assert.throws(() => submit({ videos: refs(4) }), /参考视频.*3 个/)
  assert.throws(() => submit({ audios: refs(4) }), /参考音频.*3 段/)
  assert.throws(() => submit({ images: refs(9), videos: refs(3), audios: refs(1) }), /合计最多 12 个/)
  assert.throws(() => submit({ firstFrame: refs(1)[0], images: refs(1) }), /首尾帧不能与普通参考/)
  assert.throws(() => submit({ lastFrame: refs(1)[0] }), /请先提供首帧/)
  const frames = submit({ firstFrame: 'https://example.invalid/f', lastFrame: 'https://example.invalid/l' }).body
  assert.equal(frames.firstFrame, 'https://example.invalid/f')
  assert.equal(frames.lastFrame, 'https://example.invalid/l')
  for (const value of [true, false]) {
    assert.throws(() => submit({ generateAudio: value }), /当前模型不支持音频开关/)
    assert.throws(() => submit({ generate_audio: value }), /当前模型不支持音频开关/)
  }
  assert.doesNotThrow(() => submit({ prompt: '', images: refs(1) }))
  assert.throws(() => submit({ prompt: '' }), /请输入提示词，或添加/)
})

test('SD2.0 4k: tasks under the former lowercase sales name stay fixed 4K', () => {
  const { decoded, body, usage } = submit({ duration: 6, resolution: '480p' }, 'SD2.0 4k')
  assert.equal(decoded.model, 'SD2.0 4k')
  assert.equal(body.model, 'lltai-vs-2.0')
  assert.equal(body.resolution, '4K')
  assert.equal(body.ratio, '1:1')
  assert.equal(usage.seconds, 6)
  assert.throws(() => submit({ duration: 16 }, 'SD2.0 4k'), /视频时长需在 4 到 15 秒之间/)
})

test('existing SD2.0 tiers keep their lowercase upstream quality', () => {
  for (const quality of ['480p', '720p', '1080p']) {
    const { body, usage } = submit({ resolution: '4K' }, `SD2.0 ${quality.toUpperCase()}`)
    assert.equal(body.resolution, quality)
    assert.equal(body.model, 'lltai-vs-2.0')
    assert.equal(usage.seconds, 5)
  }
})
