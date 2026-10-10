import assert from 'node:assert/strict'
import test from 'node:test'
import * as plugin from '../plugins/xm-video/plugin.js'

// Series name -> [tier key, upstream quality, upstream ID without a channel mapping, legacy fixed name]
const SERIES = {
  'SD2.5': { mapped: 'lltai-vs-2.5', tiers: [
    ['480p', '480p', 'dvc-seedance-2.5-480p', 'SD2.5 480P'],
    ['720p', '720p', 'dvc-seedance-2.5', 'SD2.5 720P'],
    ['1080p', '1080p', 'dvc-seedance-2.5-1080p', 'SD2.5 1080P'],
  ] },
  'SD2.0': { mapped: 'lltai-vs-2.0', tiers: [
    ['480p', '480p', 'cvd-seedance-2.0', 'SD2.0 480P'],
    ['720p', '720p', 'cvd-seedance-2.0', 'SD2.0 720P'],
    ['1080p', '1080p', 'cvd-seedance-2.0', 'SD2.0 1080P'],
    ['4k', '4K', 'cvd-seedance-2.0', 'SD2.0 4K'],
  ] },
  'kling-3.0-turbo': { tiers: [
    ['720p', '720p', 'kling-3.0-turbo', 'kling-3.0-turbo-720p'],
    ['1080p', '1080p', 'kling-3.0-turbo', 'kling-3.0-turbo-1080p'],
    ['2k', '2k', 'kling-3.0-turbo', 'kling-3.0-turbo-2k'],
    ['4k', '4k', 'kling-3.0-turbo', 'kling-3.0-turbo-4k'],
  ] },
  'seedance-2.0-mini官方版': { tiers: [
    ['480p', '480p', 'seedance-2.0-mini-480p', 'seedance-2.0-mini-480p'],
    ['720p', '720p', 'seedance-2.0-mini-720p', 'seedance-2.0-mini-720p'],
  ] },
  'seedance-2.5官方版': { tiers: [['720p', '720p', 'doubao-seedance-2-5-720p', 'Seedance-2.5-720p官方版']] },
  'seedance-2.0官方版': { tiers: [['720p', '720p', 'doubao-seedance-2-0-720p', 'Seedance-2.0-720p官方版']] },
  'seedance-2.0-fast官方版': { tiers: [['720p', '720p', 'doubao-seedance-2-0-fast-720p', 'Seedance-2.0-fast-720p官方版']] },
}

function submit(model, input = {}, upstreamModel = model) {
  const decoded = plugin.decodeRequest({
    model, body: { kind: 'json', value: { prompt: 'Series fixture', ratio: '16:9', ...input } },
  })
  const ctx = { model, upstreamModel, requestBody: decoded.requestBody, baseUrl: 'https://example.invalid', apiKey: 'fixture' }
  return { decoded, body: plugin.buildSubmitRequest(ctx).body, usage: plugin.extractUsage(ctx) }
}

for (const [series, { mapped, tiers }] of Object.entries(SERIES)) {
  test(`${series}: the lowest tier is the default and is billed`, () => {
    const [key, quality, upstream] = tiers[0]
    const { decoded, body, usage } = submit(series)
    assert.equal(decoded.model, series)
    assert.equal(decoded.requestBody.resolution, key)
    assert.equal(body.resolution, quality)
    assert.equal(body.model, upstream)
    assert.deepEqual(usage, { seconds: body.duration, resolution: key })
  })

  test(`${series}: each tier routes, bills and matches its legacy fixed name`, () => {
    for (const [key, quality, upstream, legacy] of tiers) {
      for (const input of [
        { resolution: key }, { resolution: key.toUpperCase() }, { quality: key },
        { metadata: { resolution: key.toUpperCase() } }, { vquality: key },
      ]) {
        const { decoded, body, usage } = submit(series, { duration: 6, ...input })
        assert.equal(body.resolution, quality, JSON.stringify(input))
        assert.equal(body.model, upstream)
        assert.equal(decoded.requestBody.resolution, key)
        assert.equal(decoded.requestBody.metadata?.resolution, undefined)
        assert.deepEqual(usage, { seconds: 6, resolution: key })
      }
      // Capabilities derive from the series, so the wire request is identical.
      const fixed = submit(legacy, { duration: 6, resolution: tiers[0][0] }, mapped || legacy)
      const viaSeries = submit(series, { duration: 6, resolution: key }, mapped || series)
      assert.deepEqual(viaSeries.body, fixed.body)
      assert.deepEqual(viaSeries.usage, fixed.usage)
      if (mapped) assert.equal(viaSeries.body.model, mapped)
    }
  })

  test(`${series}: unsupported resolutions are rejected, never downgraded`, () => {
    const supported = tiers.map(([key]) => key.toUpperCase()).join('、')
    for (const value of ['360p', '8k', 'auto', ...['480p', '720p', '1080p', '2k', '4k'].filter(k => !tiers.some(t => t[0] === k))]) {
      assert.throws(() => submit(series, { resolution: value }), new RegExp(`当前模型支持的分辨率：${supported}，请选择其中之一`))
    }
  })
}

test('series: numeric resolutions and standard frame sizes select a tier', () => {
  assert.equal(submit('SD2.5', { resolution: 720 }).usage.resolution, '720p')
  assert.equal(submit('SD2.5', { resolution: '1080' }).usage.resolution, '1080p')
  for (const [size, key, ratio] of [['1280x720', '720p', '16:9'], ['1080x1920', '1080p', '9:16'], ['854x480', '480p', '16:9']]) {
    const { body, usage } = submit('SD2.5', { ratio: undefined, size }, 'lltai-vs-2.5')
    assert.equal(usage.resolution, key)
    assert.equal(body.ratio, ratio)
  }
  const fourK = submit('SD2.0', { ratio: undefined, size: '3840x2160' }, 'lltai-vs-2.0')
  assert.deepEqual([fourK.body.resolution, fourK.body.ratio, fourK.usage.resolution], ['4K', '16:9', '4k'])
  assert.equal(submit('kling-3.0-turbo', { size: '2560x1440' }).usage.resolution, '2k')
  // An explicit resolution wins over size; non-standard sizes only imply a ratio.
  assert.equal(submit('SD2.5', { resolution: '480p', size: '1920x1080' }).usage.resolution, '480p')
  for (const size of ['1024x1024', '1440x1440', 'constructor']) assert.equal(submit('SD2.5', { size }).usage.resolution, '480p')
  assert.throws(() => submit('seedance-2.0-mini官方版', { size: '1920x1080' }), /支持的分辨率：480P、720P/)
})

test('series: SD2.5 still requires an explicit ratio on lltai-vs-2.5', () => {
  assert.throws(() => submit('SD2.5', { ratio: undefined, resolution: '720p' }, 'lltai-vs-2.5'), /请选择具体画幅比例/)
  assert.throws(() => submit('SD2.5', { ratio: 'auto' }, 'lltai-vs-2.5'), /当前模型不支持自动比例/)
  assert.equal(submit('SD2.5', { ratio: '21:9', resolution: '1080p' }, 'lltai-vs-2.5').body.ratio, '21:9')
})

test('legacy fixed names ignore requested resolutions and keep their tier', () => {
  for (const [model, key] of [['SD2.5 1080P', '1080p'], ['seedance-2.0-mini-480p', '480p'], ['kling-3.0-turbo-2k', '2k'], ['SD2.0 4k', '4k']]) {
    const { decoded, usage } = submit(model, { resolution: '720P', metadata: { resolution: '4K' } })
    assert.equal(decoded.requestBody.resolution, key)
    assert.equal(decoded.requestBody.metadata.resolution, undefined)
    assert.equal(usage.resolution, key)
  }
})

test('unknown models pass the requested quality through without a billed tier', () => {
  const { decoded, body, usage } = submit('future-video', { duration: 7, metadata: { resolution: '4K' } })
  assert.equal(decoded.requestBody.resolution, undefined)
  assert.equal(decoded.requestBody.metadata.resolution, undefined)
  assert.equal(decoded.requestBody.quality, '4K')
  assert.equal(body.resolution, '4K')
  assert.deepEqual(usage, { seconds: 7 })
  assert.equal(submit('future-video', { duration: 7 }).body.resolution, undefined)
})

test('usage schema declares every tier the plugin can bill', () => {
  const declared = plugin.meta.usageSchema.resolution.enum
  for (const [series, { tiers }] of Object.entries(SERIES)) {
    for (const [key] of tiers) assert.ok(declared.includes(key), `${series} ${key}`)
  }
  assert.ok(declared.includes('768p'))
  assert.equal(plugin.meta.version, '3.2.2')
})

test('each series declares exactly the tiers it sells, in display order', () => {
  assert.equal(plugin.meta.dynamicModels, true)
  assert.deepEqual(plugin.meta.models, Object.keys(SERIES))
  assert.deepEqual(plugin.meta.usageProfiles.map((p) => p.models), Object.keys(SERIES).map((name) => [name]))
  for (const profile of plugin.meta.usageProfiles) {
    const [series] = profile.models
    const keys = SERIES[series].tiers.map(([key]) => key)
    assert.deepEqual(profile.schema.resolution.enum, keys, series)
    assert.deepEqual(Object.keys(profile.schema.resolution.enumLabels), keys, series)
    assert.deepEqual(profile.schema.seconds, plugin.meta.usageSchema.seconds, series)
    for (const [key] of SERIES[series].tiers) assert.equal(submit(series, { resolution: key }).usage.resolution, key)
  }
  // Legacy fixed names and unknown channel models keep the superset schema.
  for (const name of ['SD2.5 480P', 'SD2.0 4K', 'kling-3.0-turbo-4k', 'Seedance-2.5-720p官方版', 'future-video']) {
    assert.ok(!plugin.meta.models.includes(name), name)
  }
  assert.deepEqual(plugin.meta.usageSchema.resolution.enum, ['480p', '720p', '768p', '1080p', '2k', '4k'])
})
