import { cp } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { buildMarketplace } from './build-marketplace.mjs'

if (process.env.GITHUB_ACTIONS !== 'true' || process.env.GITHUB_REF !== 'refs/heads/main') {
  throw new Error('Publishing is restricted to the main-branch GitHub Actions workflow')
}

function git(args, { cwd = process.cwd(), allowed = [0] } = {}) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' })
  if (!allowed.includes(result.status)) throw new Error(`git ${args[0]} failed: ${result.stderr}`)
  return result
}

const root = process.cwd()
const registry = path.join(root, '.registry')
const published = git(['ls-remote', '--exit-code', '--heads', 'origin', 'marketplace'], { allowed: [0, 2] }).status === 0
if (published) {
  git(['fetch', '--depth=1', 'origin', 'marketplace'])
  git(['worktree', 'add', '--detach', registry, 'FETCH_HEAD'])
} else {
  git(['worktree', 'add', '--detach', registry, 'HEAD'])
  git(['switch', '--orphan', 'marketplace'], { cwd: registry })
}
const output = path.join(root, '.publish')
await buildMarketplace({ root, output, previous: published ? registry : undefined })
for (const entry of ['index.json', 'LICENSE', 'README.md', 'plugins']) {
  await cp(path.join(output, entry), path.join(registry, entry), { recursive: true })
}
git(['add', '--all', '--', 'index.json', 'LICENSE', 'README.md', 'plugins'], { cwd: registry })
if (git(['diff', '--cached', '--quiet'], { cwd: registry, allowed: [0, 1] }).status === 0) {
  console.log('Registry already matches these plugin versions')
} else {
  git(['-c', 'user.name=github-actions[bot]', '-c', 'user.email=41898282+github-actions[bot]@users.noreply.github.com',
    'commit', '-m', `Publish plugins from ${process.env.GITHUB_SHA.slice(0, 12)}`], { cwd: registry })
  git(['push', 'origin', 'HEAD:refs/heads/marketplace'], { cwd: registry })
  console.log('Published https://raw.githubusercontent.com/blackdm666/88api-task-plugins/marketplace/index.json')
}
