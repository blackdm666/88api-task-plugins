import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import path from 'node:path'

const root = process.cwd()
const host = path.join(root, process.env.PLUGIN_TEST_HOST_DIR || '.host')
const lock = JSON.parse(await readFile(path.join(root, 'host.lock.json'), 'utf8'))
if (!/^[a-f0-9]{40}$/.test(lock.commit)) throw new Error('Host commit must be pinned')
const revision = spawnSync('git', ['-C', host, 'rev-parse', 'HEAD'], { encoding: 'utf8' })
if (revision.status !== 0 || revision.stdout.trim() !== lock.commit) throw new Error('The .host checkout does not match host.lock.json')
for (const key of lock.plugins) {
  if (!/^[a-z0-9][a-z0-9-]{0,29}$/.test(key)) throw new Error('Invalid plugin key')
  const destination = path.join(host, 'plugins', 'tasks', key, 'plugin.js')
  try {
    await readFile(destination)
    await copyFile(path.join(root, 'plugins', key, 'plugin.js'), destination)
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
    // New third-party plugins are admitted by the catalogue contract below;
    // they are not silently added to the host's built-in inventory.
  }
}
// Keep new independent plugins available to the host-side catalogue and
// contract tests without adding them to the host's built-in inventory.
await mkdir(path.join(host, 'plugins', 'seedream-pro'), { recursive: true })
await copyFile(path.join(root, 'plugins', 'seedream-pro', 'plugin.js'),
  path.join(host, 'plugins', 'seedream-pro', 'plugin.js'))
await copyFile(path.join(root, 'tests', 'host', 'catalogue_contract_test.go'),
  path.join(host, 'pkg', 'jsplugin', 'independent_catalogue_test.go'))
await copyFile(path.join(root, 'tests', 'host', 'xm_video_vs25_test.go'),
  path.join(host, 'pkg', 'jsplugin', 'independent_xm_video_vs25_test.go'))
await copyFile(path.join(root, 'tests', 'host', 'minimax_h3_async_test.go'),
  path.join(host, 'pkg', 'jsplugin', 'independent_minimax_h3_async_test.go'))
await copyFile(path.join(root, 'tests', 'host', 'h3_video_contract_test.go'),
  path.join(host, 'pkg', 'jsplugin', 'independent_h3_video_contract_test.go'))
await copyFile(path.join(root, 'tests', 'host', 'gx_video_contract_test.go'),
  path.join(host, 'pkg', 'jsplugin', 'independent_gx_video_contract_test.go'))
await copyFile(path.join(root, 'tests', 'host', 'sdgo_video_contract_test.go'),
  path.join(host, 'pkg', 'jsplugin', 'independent_sdgo_video_contract_test.go'))
await copyFile(path.join(root, 'tests', 'host', 'alibaba_wan3_contract_test.go'),
  path.join(host, 'pkg', 'jsplugin', 'independent_alibaba_wan3_contract_test.go'))
await copyFile(path.join(root, 'tests', 'host', 'seedream_pro_contract_test.go'),
  path.join(host, 'pkg', 'jsplugin', 'independent_seedream_pro_contract_test.go'))
await copyFile(path.join(root, 'tests', 'host', 'grok_video_artifact_test.go'),
  path.join(host, 'controller', 'independent_grok_video_artifact_test.go'))
await copyFile(path.join(root, 'tests', 'host', 'vertex_omni_contract_test.go'),
  path.join(host, 'relay', 'channel', 'task', 'jsplugin', 'independent_vertex_omni_contract_test.go'))
await copyFile(path.join(root, 'tests', 'host', 'xm_video_series_test.go'),
  path.join(host, 'relay', 'channel', 'task', 'jsplugin', 'independent_xm_video_series_test.go'))
// The pinned host's historical XinMeng test asserted an internal English
// error string. The plugin now exposes Chinese guidance to canvas users, so
// align that sandbox-only assertion with the intentional public message.
const xinmengHostTest = path.join(host, 'plugins', 'tasks', 'xinmeng-wan3', 'plugin.js')
const xinmengTest = path.join(host, 'pkg', 'jsplugin', 'xinmeng_video_test.go')
const legacyError = 'assert.ErrorContains(t, err, "too many media references in total")'
const friendlyError = 'assert.ErrorContains(t, err, "参考素材总数超过当前模型限制")'
const xinmengTestSource = await readFile(xinmengTest, 'utf8')
if (xinmengTestSource.includes(legacyError)) {
  await writeFile(xinmengTest, xinmengTestSource.replace(legacyError, friendlyError))
} else if (!xinmengTestSource.includes(friendlyError)) {
  throw new Error('Pinned host XinMeng test no longer has the expected media-limit assertion')
}
// xm-video 3.2.0 declares its series names so each carries a per-model
// resolution enum (usageProfiles must name declared models). The pinned host
// asserts the factory copy claims nothing; pin the exact claim list instead so
// it still cannot shadow another plugin's alias such as minimax-h3-768p.
const xmSeries = '[]string{"SD2.5", "SD2.0", "kling-3.0-turbo", "seedance-2.0-mini官方版", "seedance-2.5官方版", "seedance-2.0官方版", "seedance-2.0-fast官方版"}'
for (const [file, subject] of [
  [path.join(host, 'pkg', 'jsplugin', 'xinmeng_video_test.go'), 'plugin'],
  [path.join(host, 'plugins', 'builtin_plugins_test.go'), 'xinmeng'],
]) {
  const empty = `assert.Empty(t, ${subject}.Meta.Models)`
  const series = `assert.Equal(t, ${xmSeries}, ${subject}.Meta.Models)`
  const testSource = await readFile(file, 'utf8')
  if (testSource.includes(empty)) {
    await writeFile(file, testSource.replace(empty, series))
  } else if (!testSource.includes(series)) {
    throw new Error(`Pinned host test ${path.basename(file)} no longer has the expected XM-Video model assertion`)
  }
}
await mkdir(path.join(host, 'web', 'dist'), { recursive: true })
await writeFile(path.join(host, 'web', 'dist', 'index.html'), '<!doctype html><title>Host contract test</title>\n')
console.log(`Prepared ${lock.plugins.length} plugin sources in the isolated host checkout`)
