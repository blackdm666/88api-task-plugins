import { createHash } from 'node:crypto'
import { cp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

export function sha256(source) {
  return createHash('sha256').update(source).digest('hex')
}

function stableVersion(version) {
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) {
    throw new Error(`Marketplace releases require a stable x.y.z version: ${version}`)
  }
  const parts = version.split('.').map(Number)
  if (!parts.every(Number.isSafeInteger)) throw new Error('Version component is too large')
  return parts
}

function compareVersions(left, right) {
  const a = stableVersion(left)
  const b = stableVersion(right)
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2]
}

export async function buildMarketplace({ root, output, previous }) {
  root = path.resolve(root)
  output = path.resolve(output)
  const lock = JSON.parse(await readFile(path.join(root, 'host.lock.json'), 'utf8'))
  let prior = { indexVersion: 1, plugins: [] }
  const archives = []
  if (previous) {
    previous = path.resolve(previous)
    if (output === previous) throw new Error('Output must be separate from the published registry')
    prior = JSON.parse(await readFile(path.join(previous, 'index.json'), 'utf8'))
    if (prior.indexVersion !== 1 || !Array.isArray(prior.plugins)) throw new Error('Invalid existing registry')
    for (const plugin of prior.plugins) {
      for (const release of plugin.versions) {
        const relative = `plugins/${plugin.key}/${release.version}/plugin.js`
        if (!/^[a-z0-9][a-z0-9-]{0,29}$/.test(plugin.key) || release.path !== relative) {
          throw new Error('Published plugin path does not match its identity')
        }
        stableVersion(release.version)
        const content = await readFile(path.join(previous, relative))
        if (sha256(content) !== release.sha256) throw new Error(`Published archive was modified: ${relative}`)
        archives.push({ relative, content })
      }
    }
  }

  const entries = (await readdir(path.join(root, 'plugins'), { withFileTypes: true })).filter(x => x.isDirectory())
  const current = new Map()
  for (const entry of entries) {
    const sourcePath = path.join(root, 'plugins', entry.name, 'plugin.js')
    const raw = await readFile(sourcePath, 'utf8')
    const source = raw.replace(/\r\n/g, '\n')
    if (Buffer.byteLength(source) > 1024 * 1024) throw new Error('Plugin source exceeds the NewAPI size limit')
    // Sources are maintained in this repository and are single-file ES modules.
    // Production admission is separately tested with the pinned NewAPI sandbox.
    const module = await import(pathToFileURL(sourcePath).href + '?sha=' + sha256(source))
    const meta = module.meta
    if (!meta || meta.key !== entry.name || !/^[a-z0-9][a-z0-9-]{0,29}$/.test(meta.key)) throw new Error('Plugin key must match its directory')
    if (meta.apiVersion !== lock.apiVersion || !meta.name || !meta.version) throw new Error(`Invalid manifest: ${entry.name}`)
    stableVersion(meta.version)
    const priorPlugin = prior.plugins.find(x => x.key === meta.key)
    if (priorPlugin && compareVersions(meta.version, priorPlugin.latest) < 0) throw new Error(`Refusing to roll latest backward: ${meta.key}`)
    const digest = sha256(source)
    const existing = priorPlugin?.versions.find(x => x.version === meta.version)
    if (existing && existing.sha256 !== digest) throw new Error(`Published version is immutable; bump meta.version: ${meta.key}@${meta.version}`)
    current.set(meta.key, { meta, source, digest, priorPlugin })
  }
  if (current.size !== lock.plugins.length || lock.plugins.some(key => !current.has(key))) {
    throw new Error('Plugin inventory must match host.lock.json')
  }
  for (const plugin of prior.plugins) {
    if (!current.has(plugin.key)) throw new Error(`Do not silently remove a published plugin: ${plugin.key}`)
  }
  await mkdir(output, { recursive: true })
  for (const { relative, content } of archives) {
    await mkdir(path.dirname(path.join(output, relative)), { recursive: true })
    await writeFile(path.join(output, relative), content)
  }
  const plugins = []
  for (const [key, { meta, source, digest, priorPlugin }] of [...current].sort(([a], [b]) => a.localeCompare(b))) {
    const relative = `plugins/${key}/${meta.version}/plugin.js`
    await mkdir(path.dirname(path.join(output, relative)), { recursive: true })
    await writeFile(path.join(output, relative), source, 'utf8')
    const versions = [
      { version: meta.version, path: relative, sha256: digest, minApiVersion: meta.apiVersion, kind: 'task' },
      ...(priorPlugin?.versions ?? []).filter(x => x.version !== meta.version),
    ].sort((a, b) => compareVersions(b.version, a.version))
    plugins.push({
      key, name: meta.name, description: meta.description, models: meta.models ?? [],
      protocols: meta.protocols ?? [], latest: meta.version, versions,
    })
  }
  const index = { indexVersion: 1, name: '88API Task Plugins', plugins }
  await writeFile(path.join(output, 'index.json'), JSON.stringify(index, null, 2) + '\n')
  await cp(path.join(root, 'LICENSE'), path.join(output, 'LICENSE'))
  await writeFile(path.join(output, 'README.md'), '# 88API Task Plugin Registry\n\nGenerated after validation. Source and maintenance guide: https://github.com/blackdm666/88api-task-plugins\n\nDo not edit released plugin archives.\n')
  return index
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = process.argv.slice(2)
  const options = { root: process.cwd(), output: path.resolve('.publish'), previous: undefined }
  while (args.length) {
    const flag = args.shift()
    const value = args.shift()
    if (!value || !['--root', '--out', '--previous'].includes(flag)) throw new Error('Usage: build-marketplace.mjs [--root DIR] [--out DIR] [--previous DIR]')
    options[flag === '--out' ? 'output' : flag.slice(2)] = value
  }
  const result = await buildMarketplace(options)
  console.log(JSON.stringify({ plugins: result.plugins.map(x => ({ key: x.key, version: x.latest })), output: options.output }))
}
