import { describe, expect, it } from 'vitest'

import { collectLaunchPaths } from '../src/main/launch-paths'

describe('collectLaunchPaths', () => {
  it('collects supported argv files in order and removes duplicates', () => {
    expect(
      collectLaunchPaths(
        ['TeleOffice.exe', 'first.docx', 'notes.txt', 'second.xlsx', 'first.docx'],
        undefined,
        () => true,
      ),
    ).toEqual(['first.docx', 'second.xlsx'])
  })

  it('accepts a .tsv from argv or the second-instance payload', () => {
    expect(
      collectLaunchPaths(['TeleOffice.app', '/data/variants.tsv'], undefined, () => true),
    ).toEqual(['/data/variants.tsv'])
    // a bare .txt is still not a document
    expect(collectLaunchPaths(['TeleOffice.app', '/notes.txt'], undefined, () => true)).toEqual([])
  })

  it('collects argv and second-instance payload files without duplicates', () => {
    expect(
      collectLaunchPaths(
        ['TeleOffice.exe', 'first.docx', 'second.pptx'],
        {
          launchPaths: ['first.docx', 'third.pdf', 42, ''],
          launchPath: 'legacy.md',
        },
        () => true,
      ),
    ).toEqual(['first.docx', 'second.pptx', 'third.pdf', 'legacy.md'])
  })

  it('accepts a legacy launchPath payload', () => {
    expect(
      collectLaunchPaths(['TeleOffice.exe'], { launchPath: 'legacy.docx' }, () => true),
    ).toEqual(['legacy.docx'])
  })

  it('falls back to the first existing unsupported argv file', () => {
    expect(
      collectLaunchPaths(
        ['TeleOffice.exe', 'missing.doc', 'legacy.rtf'],
        undefined,
        (path) => path === 'legacy.rtf',
      ),
    ).toEqual(['legacy.rtf'])
  })
})
