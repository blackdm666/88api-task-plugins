import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { buildMarketplace, sha256 } from '../scripts/build-marketplace.mjs'

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), '88api-plugin-registry-'))
  t.after(async () => {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()))
    assert.ok(path.basename(root).startsWith('88api-plugin-registry-'))
    await rm(root, { recursive: true, force: true })
  })
  await mkdir(path.join(root, 'plugins', 'demo'), { recursive: true })
  await writeFile(path.join(root, 'host.lock.json'), JSON.stringify({ apiVersion: 1, plugins: ['demo'] }))
  await writeFile(path.join(root, 'LICENSE'), 'fixture license\n')
  const plugin = path.join(root, 'plugins', 'demo', 'plugin.js')
  await writeFile(path.join(root, 'package.json'), '{"type":"module"}')
  return { root, plugin, output: path.join(root, 'first') }
}

const source = version => `export const meta={apiVersion:1,key:"demo",name:"Demo",version:"${version}",models:[],protocols:["openai_video"]};\n`

test('the published archive and index agree on identity, canonical bytes and integrity', async t => {
  const f = await fixture(t)
  await writeFile(f.plugin, source('1.0.0').replaceAll('\n', '\r\n'))
  const index = await buildMarketplace(f)
  const plugin = index.plugins[0]
  assert.equal(index.indexVersion, 1)
  assert.equal(plugin.key, 'demo')
  assert.equal(plugin.latest, '1.0.0')
  assert.equal(plugin.versions[0].kind, 'task')
  assert.equal(plugin.versions[0].minApiVersion, 1)
  const content = await readFile(path.join(f.output, plugin.versions[0].path), 'utf8')
  assert.equal(content, source('1.0.0'))
  assert.equal(plugin.versions[0].sha256, sha256(content))
})

test('publishing a new version preserves the previous version for rollback', async t => {
  const f = await fixture(t)
  await writeFile(f.plugin, source('1.0.0'))
  const first = await buildMarketplace(f)
  await writeFile(f.plugin, source('1.1.0'))
  const output = path.join(f.root, 'second')
  const next = await buildMarketplace({ ...f, output, previous: f.output })
  assert.deepEqual(next.plugins[0].versions.map(x => x.version), ['1.1.0', '1.0.0'])
  assert.deepEqual(next.plugins[0].versions[1], first.plugins[0].versions[0])
  assert.equal(await readFile(path.join(output, first.plugins[0].versions[0].path), 'utf8'), source('1.0.0'))
})

test('changing an already released version or moving latest backward is rejected', async t => {
  const f = await fixture(t)
  await writeFile(f.plugin, source('1.1.0'))
  await buildMarketplace(f)
  await writeFile(f.plugin, source('1.1.0') + '// changed\n')
  await assert.rejects(buildMarketplace({ ...f, output: path.join(f.root, 'changed'), previous: f.output }), /immutable/)
  await writeFile(f.plugin, source('1.0.0'))
  await assert.rejects(buildMarketplace({ ...f, output: path.join(f.root, 'backward'), previous: f.output }), /backward/)
})

test('tampered archive bytes and paths escaping the registry are rejected', async t => {
  const f = await fixture(t)
  await writeFile(f.plugin, source('1.0.0'))
  const index = await buildMarketplace(f)
  const archive = path.join(f.output, index.plugins[0].versions[0].path)
  await writeFile(archive, 'tampered')
  await assert.rejects(buildMarketplace({ ...f, output: path.join(f.root, 'tampered'), previous: f.output }), /modified/)
  index.plugins[0].versions[0].path = '../outside.js'
  await writeFile(path.join(f.output, 'index.json'), JSON.stringify(index))
  await assert.rejects(buildMarketplace({ ...f, output: path.join(f.root, 'escaped'), previous: f.output }), /path/)
})
