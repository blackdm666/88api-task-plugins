import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import * as plugin from '../plugins/alibaba/plugin.js'

const models = ['wan3.0-video', 'wan3.0-video-prime']
function context(model, requestBody) {
  return { model, upstreamModel: model, baseUrl: 'https://example.invalid', apiKey: 'fixture', requestBody }
}

test('Alibaba override contains only the version bump and Wan3 ratio fix', async () => {
  const source = await readFile(new URL('../plugins/alibaba/plugin.js', import.meta.url), 'utf8')
  const restored = source.replace('version: "1.4.2"', 'version: "1.4.1"')
    .replace('ratios.push("adaptive", "21:9")', 'ratios.push("adaptive")')
  assert.equal(createHash('sha256').update(restored).digest('hex'),
    'c8f217afe6fe79bb0db3e723730a86399cee74e8087f474859e39e52a6acb55d')
  assert.equal(plugin.meta.key, 'alibaba')
  assert.equal(plugin.meta.version, '1.4.2')
  assert.equal(plugin.meta.author.name, 'QuantumNous')
})

for (const model of models) {
  for (const resolution of ['480P', '720P', '1080P']) {
    test(`${model} sends native 21:9 at ${resolution} through OpenAI Videos`, () => {
      const decoded = plugin.protocols.openai_video.decodeRequest({
        model, body: { kind: 'json', value: { model, prompt: 'A toy boat', seconds: 2, resolution, ratio: '21:9' } },
      })
      const ctx = context(model, decoded.requestBody)
      const converted = plugin.buildSubmitRequest(ctx)
      assert.equal(converted.body.parameters.ratio, '21:9')
      assert.equal(converted.body.parameters.resolution, resolution)
      assert.equal(converted.body.parameters.duration, 2)
      assert.equal(converted.url, 'https://example.invalid/api/v1/services/aigc/video-generation/video-synthesis')
      assert.deepEqual(plugin.extractUsage(ctx), { seconds: 2, resolution })
    })
  }
  test(`${model} native, metadata and multipart paths preserve 21:9`, () => {
    const native = plugin.native.createVideoTask({
      body: { kind: 'json', value: { model, input: { prompt: 'A toy boat' }, parameters: { duration: 2, resolution: '480P', ratio: '21:9' } } },
    })
    assert.equal(plugin.buildSubmitRequest(context(model, native.requestBody)).body.parameters.ratio, '21:9')
    const multipart = plugin.protocols.openai_video.decodeRequest({
      model, body: { kind: 'multipart', fields: { prompt: ['A toy boat'], seconds: ['2'], resolution: ['480P'], ratio: ['21:9'] }, files: [] },
    })
    assert.equal(plugin.buildSubmitRequest(context(model, multipart.requestBody)).body.parameters.ratio, '21:9')
    const metadata = { model, prompt: 'A toy boat', metadata: { parameters: { duration: 2, resolution: '480P', ratio: '21:9' } } }
    assert.equal(plugin.buildSubmitRequest(context(model, metadata)).body.parameters.ratio, '21:9')
  })
  test(`${model} keeps existing ratios and rejects unknown ratios`, () => {
    for (const ratio of ['16:9', '9:16', '1:1', '4:3', '3:4', 'adaptive']) {
      const request = plugin.buildSubmitRequest(context(model, { model, prompt: 'Boat', seconds: 2, ratio }))
      assert.equal(request.body.parameters.ratio, ratio)
    }
    assert.throws(() => plugin.buildSubmitRequest(context(model, { model, prompt: 'Boat', seconds: 2, ratio: '32:9' })), /ratio must/)
  })
  test(`${model} completion and reference-video billing are unchanged`, () => {
    const ctx = context(model, { model, prompt: 'Boat', seconds: 2, resolution: '480P', ratio: '21:9',
      media: [{ type: 'reference_video', url: 'https://example.invalid/reference.mp4' }] })
    assert.deepEqual(plugin.extractUsage(ctx), { seconds: 30, resolution: '480P' })
    assert.deepEqual(plugin.extractUsageOnComplete(ctx, {}, {
      usage: { input_video_duration: 5, output_video_duration: 2, SR: 480 },
    }), { seconds: 7, resolution: '480P' })
    assert.deepEqual(plugin.parseTaskResult(ctx, {
      output: { task_status: 'SUCCEEDED', video_url: 'https://example.invalid/output.mp4' },
    }), { status: 'SUCCESS', url: 'https://example.invalid/output.mp4' })
  })
}

for (const model of ['wan2.7-t2v', 'wan2.6-t2v', 'wan2.5-t2v-preview']) {
  test(`${model} does not gain Wan3-only 21:9 support`, () => {
    assert.throws(() => plugin.buildSubmitRequest(context(model, { model, prompt: 'Boat', duration: 5, resolution: '720P', ratio: '21:9' })), /ratio must/)
    assert.equal(plugin.buildSubmitRequest(context(model, { model, prompt: 'Boat', duration: 5, resolution: '720P', ratio: '16:9' })).body.model, model)
  })
}
