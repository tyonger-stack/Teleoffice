// Concurrent registry writer for the multi-process test: adds 20 entries.
// Run via the repo tsx (node_modules/.bin/tsx), not imported by vitest.
import { addTemplate } from '../src/slides/template-registry'

const dir = process.argv[2] ?? ''
const worker = Number(process.argv[3] ?? '0')
const src = process.argv[4] ?? ''
if (!dir || !src || !Number.isInteger(worker)) {
  console.error('usage: worker <templates-dir> <worker-index> <source-pptx> [start-at-ms]')
  process.exit(2)
}
// Optional start time (epoch ms): every worker spins until then, so they all
// reach the lock, including a planted stale one, at about the same moment.
const startAt = Number(process.argv[5] ?? '0')
while (Number.isFinite(startAt) && Date.now() < startAt) {
  // busy-wait on purpose; a timer would let workers drift apart
}
const env = { ...process.env, TELEOFFICE_TEMPLATES_DIR: dir }
for (let j = 0; j < 20; j++) {
  const name = 'c-w' + worker + '-n' + j
  addTemplate(name, src, {}, env)
}
