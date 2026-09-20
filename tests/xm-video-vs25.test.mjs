import assert from 'node:assert/strict'
import test from 'node:test'
import * as plugin from '../plugins/xm-video/plugin.js'

function submit(model, input = {}, upstreamModel = 'lltai-vs-2.5') {
  const decoded = plugin.decodeRequest({
    model,
    body: { kind: 'json', value: { prompt: 'Protocol fixture', ...input } },
  })
  const ctx = {
    model, upstreamModel, requestBody: decoded.requestBody,
    baseUrl: 'https://example.invalid/v1', apiKey: 'fixture',
  }
  return { body: plugin.buildSubmitRequest(ctx).body, usage: plugin.extractUsage(ctx) }
}

for (const quality of ['480p', '720p', '1080p']) {
  const model = `SD2.5 ${quality.toUpperCase()}`
  test(`${model}: fixed quality and frozen billing quantity`, () => {
    for (const duration of [4, 5, 8, 30]) {
      const { body, usage } = submit(model, {
        duration, resolution: '4k', metadata: { resolution: '720p' },
        ratio: '16:9', generateAudio: false,
      })
      assert.equal(body.model, 'lltai-vs-2.5')
      assert.equal(body.resolution, quality)
      assert.equal(body.duration, duration)
      assert.equal(usage.seconds, duration)
      assert.equal(body.generateAudio, false)
      assert.equal(body.ratio, '16:9')
    }
  })
  test(`${model}: explicit ratio is required and auto is rejected`, () => {
    for (const input of [{}, { ratio: 'auto' }, { metadata: { aspect_ratio: 'auto' } }]) {
      assert.throws(() => submit(model, input), /ratio|auto/)
    }
    for (const ratio of ['16:9', '9:16', '1:1', '21:9', '3:4', '4:3']) {
      const { body, usage } = submit(model, { ratio })
      assert.equal(body.ratio, ratio)
      assert.equal(body.duration, 5)
      assert.equal(usage.seconds, 5)
    }
  })
  test(`${model}: legacy DVC mapping stays unchanged`, () => {
    const upstream = quality === '720p' ? 'dvc-seedance-2.5' : `dvc-seedance-2.5-${quality}`
    const { body } = submit(model, { ratio: 'auto' }, upstream)
    assert.equal(body.model, upstream)
    assert.equal(body.ratio, 'auto')
    assert.equal(body.resolution, quality)
  })
}

test('VS2.5 media, audio off and frame references stay intact', () => {
  const references = {
    referenceImages: Array.from({ length: 30 }, (_, i) => `https://example.invalid/i${i}`),
    referenceVideos: Array.from({ length: 10 }, (_, i) => `https://example.invalid/v${i}`),
    referenceAudios: Array.from({ length: 10 }, (_, i) => `https://example.invalid/a${i}`),
    generateAudio: false,
  }
  const { body } = submit('SD2.5 720P', { ...references, ratio: '16:9' })
  for (const [key, value] of Object.entries(references)) assert.deepEqual(body[key], value)
  const frames = { firstFrame: 'https://example.invalid/f', lastFrame: 'https://example.invalid/l' }
  const framed = submit('SD2.5 1080P', { ...frames, ratio: '16:9' }).body
  assert.equal(framed.firstFrame, frames.firstFrame)
  assert.equal(framed.lastFrame, frames.lastFrame)
})

test('existing duration and reference validation stays in place', () => {
  for (const duration of [3, 31, 4.5, -1, true]) {
    assert.throws(() => submit('SD2.5 720P', { duration }))
  }
  assert.throws(() => submit('SD2.5 720P', { ratio: '2:1' }))
  assert.throws(() => submit('SD2.5 720P', { referenceImages: Array(31).fill('https://example.invalid/i') }))
  assert.throws(() => submit('SD2.5 720P', {
    firstFrame: 'https://example.invalid/f', referenceVideos: ['https://example.invalid/v'],
  }))
})

test('SD2.0 and unknown models are not rewritten', () => {
  assert.equal(submit('SD2.0 720P', {}, 'cvd-seedance-2.0').body.ratio, '1:1')
  assert.equal(submit('custom-model', { duration: 5, ratio: 'auto' }).body.ratio, 'auto')
})

test('historical task IDs, query paths and results are provider-independent', () => {
  assert.equal(plugin.parseSubmitResponse({}, { body: { task_id: 'old-task' } }).taskId, 'old-task')
  assert.equal(plugin.buildQueryRequest({
    baseUrl: 'https://example.invalid/v1', taskId: 'old-task', apiKey: 'fixture',
  }).url, 'https://example.invalid/v1/tasks/old-task')
  assert.equal(plugin.parseTaskResult({}, {
    status: 'completed', result: 'https://example.invalid/old-video.mp4',
  }).status, 'SUCCESS')
  for (const status of ['failed', 'cancelled']) {
    assert.equal(plugin.parseTaskResult({}, { status, error: { message: 'failure' } }).status, 'FAILURE')
  }
})
