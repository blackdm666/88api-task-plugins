import assert from 'node:assert/strict'
import test from 'node:test'

import * as plugin from '../plugins/seedream-pro/plugin.js'

test('Seedream Pro keeps the latest protocol fixes without public price examples', () => {
  assert.equal(plugin.meta.key, 'seedream-pro')
  assert.equal(plugin.meta.version, '1.1.8')
  assert.deepEqual(plugin.meta.usageExamples, [])
  assert.deepEqual(plugin.meta.models, ['doubao-seedream-5-0-pro'])
  assert.match(plugin.meta.usageSchema.quality.enum.join(','), /^1K,2K$/)
  assert.equal(plugin.meta.usageSchema.image_count.unit, 'count')

  assert.equal(typeof plugin.protocols.openai_image.decodeRequest, 'function')
  assert.equal(typeof plugin.protocols.openai_image.render, 'function')
})
