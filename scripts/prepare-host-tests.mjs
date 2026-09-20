import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import path from 'node:path'

const root = process.cwd()
const host = path.join(root, '.host')
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
await copyFile(path.join(root, 'tests', 'host', 'catalogue_contract_test.go'),
  path.join(host, 'pkg', 'jsplugin', 'independent_catalogue_test.go'))
await copyFile(path.join(root, 'tests', 'host', 'xm_video_vs25_test.go'),
  path.join(host, 'pkg', 'jsplugin', 'independent_xm_video_vs25_test.go'))
// The pinned host's historical XinMeng test asserted an internal English
// error string. The plugin now exposes Chinese guidance to canvas users, so
// align that sandbox-only assertion with the intentional public message.
const xinmengHostTest = path.join(host, 'pkg', 'jsplugin', 'xinmeng_video_test.go')
const legacyError = 'assert.ErrorContains(t, err, "too many media references in total")'
const friendlyError = 'assert.ErrorContains(t, err, "参考素材总数超过当前模型限制")'
const xinmengTestSource = await readFile(xinmengHostTest, 'utf8')
if (xinmengTestSource.includes(legacyError)) {
  await writeFile(xinmengHostTest, xinmengTestSource.replace(legacyError, friendlyError))
} else if (!xinmengTestSource.includes(friendlyError)) {
  throw new Error('Pinned host XinMeng test no longer has the expected media-limit assertion')
}
await mkdir(path.join(host, 'web', 'dist'), { recursive: true })
await writeFile(path.join(host, 'web', 'dist', 'index.html'), '<!doctype html><title>Host contract test</title>\n')
console.log(`Prepared ${lock.plugins.length} plugin sources in the isolated host checkout`)
