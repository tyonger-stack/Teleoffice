#!/usr/bin/env node
// Lists commits on genspark-ai/genoffice that landed after the SHA recorded in
// tools/upstream-synced-through.txt and whose subject is not already on HEAD.
// TeleOffice integrates that history selectively, so this script never merges.
//
// Usage:
//   node tools/upstream-sync-report.mjs --upstream <ref> [--marker <sha>] [--out <file>]
//
// Exit 0 when nothing is pending, 2 when commits still need a review.
import { readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'

const MARKER_FILE = 'tools/upstream-synced-through.txt'
const MAX_ROWS = 80

function git(args) {
  const result = spawnSync('git', args, { encoding: 'utf8' })
  if (result.status !== 0) {
    process.stderr.write(result.stderr || `git ${args.join(' ')} failed\n`)
    process.exit(result.status ?? 1)
  }
  return result.stdout
}

function arg(name) {
  const index = process.argv.indexOf(name)
  if (index === -1) return ''
  return process.argv[index + 1] || ''
}

const upstream = arg('--upstream')
const outPath = arg('--out')
if (!upstream) {
  console.error(
    'Usage: node tools/upstream-sync-report.mjs --upstream <ref> [--marker <sha>] [--out <file>]',
  )
  process.exit(2)
}

const marker = (arg('--marker') || readFileSync(MARKER_FILE, 'utf8'))
  .split('\n')
  .map((line) => line.trim())
  .find((line) => line && !line.startsWith('#'))

if (!marker || !/^[0-9a-f]{7,40}$/i.test(marker)) {
  console.error(`${MARKER_FILE} must start with the last reviewed upstream commit SHA`)
  process.exit(1)
}

git(['cat-file', '-e', `${marker}^{commit}`])
git(['cat-file', '-e', `${upstream}^{commit}`])

const upstreamTip = git(['rev-parse', upstream]).trim()
const subjects = new Set(git(['log', '--format=%s', 'HEAD']).split('\n').filter(Boolean))
const rows = git(['log', '--format=%H%x09%s', `${marker}..${upstream}`])
  .split('\n')
  .filter(Boolean)
  .map((line) => {
    const tab = line.indexOf('\t')
    return { sha: line.slice(0, tab), subject: line.slice(tab + 1) }
  })

const pending = rows.filter((row) => !subjects.has(row.subject))
const report = {
  marker,
  upstream,
  upstreamTip,
  upstreamCount: rows.length,
  alreadyIntegrated: rows.length - pending.length,
  pending: pending.map((row) => ({ sha: row.sha, subject: row.subject })),
}

const shown = report.pending.slice(0, MAX_ROWS)
const hidden = report.pending.length - shown.length
const lines = [
  'TeleOffice does not auto-merge genspark-ai/genoffice. Review each commit and cherry-pick the ones that belong here.',
  '',
  `- Last reviewed upstream commit (\`${MARKER_FILE}\`): \`${report.marker}\``,
  `- Upstream tip (\`${report.upstream}\`): \`${report.upstreamTip}\``,
  `- Commits since the marker: ${report.upstreamCount}`,
  `- Already on this branch (same subject): ${report.alreadyIntegrated}`,
  `- Still to review: ${report.pending.length}`,
  '',
]
if (report.pending.length === 0) {
  lines.push('Nothing new to review.')
} else {
  lines.push('| Commit | Subject |', '| --- | --- |')
  for (const row of shown) {
    const subject = row.subject.replace(/\|/g, '\\|')
    lines.push(`| \`${row.sha.slice(0, 10)}\` | ${subject} |`)
  }
  if (hidden > 0) lines.push('', `… ${hidden} more commits not shown.`)
  lines.push(
    '',
    'After the review, set `tools/upstream-synced-through.txt` to the upstream tip you finished reviewing, including commits you chose to leave out.',
  )
}

const markdown = `${lines.join('\n')}\n`
report.markdown = markdown

if (outPath) writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`)
process.stdout.write(markdown)
process.exit(report.pending.length === 0 ? 0 : 2)
