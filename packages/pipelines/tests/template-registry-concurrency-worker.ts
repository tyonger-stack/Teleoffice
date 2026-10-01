// Concurrent registry writer for the multi-process test: adds 20 entries.
// Run via the repo tsx (node_modules/.bin/tsx), not imported by vitest.
import { addTemplate } from '../src/slides/template-registry'

const dir = process.argv[2] ?? ''
const worker = Number(process.argv[3] ?? '0')
const src = process.argv[4] ?? ''
if (!dir || !src || !Number.isInteger(worker)) {
  console.error('usage: worker <templates-dir> <worker-index> <source-pptx>')
  process.exit(2)
}
const env = { ...process.env, GENOFFICE_TEMPLATES_DIR: dir }
for (let j = 0; j < 20; j++) {
  const name = 'c-w' + worker + '-n' + j
  addTemplate(name, src, {}, env)
}
