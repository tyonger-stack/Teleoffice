import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)

interface PublishTarget {
  provider: string
  owner?: string
  repo?: string
  url?: string
  channel?: string
}

interface BuilderConfig {
  publish?: PublishTarget[]
  extraMetadata?: { teleofficeMacManualUpdate?: boolean }
  rpm?: { publish?: null }
  nsis?: { artifactName?: string }
}

function loadBuilder(env: Record<string, string | undefined>, platform: string): BuilderConfig {
  const configModule = { exports: {} as BuilderConfig }
  runInNewContext(readFileSync(resolve(import.meta.dirname, '../electron-builder.cjs'), 'utf8'), {
    module: configModule,
    __dirname: resolve(import.meta.dirname, '..'),
    process: { platform, arch: 'x64', env, execPath: '/usr/bin/node' },
    require: (id: string) =>
      id === 'node:fs' ? { ...require(id), existsSync: () => true } : require(id),
  })
  return configModule.exports
}

describe('update publish config', () => {
  it('points app-update.yml at GitHub Releases when no override URL is set', () => {
    const config = loadBuilder({}, 'linux')
    expect(config.publish).toEqual([
      { provider: 'github', owner: 'tyonger-stack', repo: 'Teleoffice' },
    ])
    expect(config.rpm?.publish).toBeNull()
    expect(config.extraMetadata?.teleofficeMacManualUpdate).toBeUndefined()
    expect(config.nsis?.artifactName).toBe('TeleOffice.Setup.${version}.${ext}')
    expect(config.nsis?.artifactName).not.toMatch(/\s/)
  })

  it('keeps a generic feed when TELEOFFICE_UPDATE_URL is set', () => {
    const config = loadBuilder(
      { TELEOFFICE_UPDATE_URL: 'https://updates.example.com/teleoffice/' },
      'linux',
    )
    expect(config.publish).toEqual([
      { provider: 'generic', url: 'https://updates.example.com/teleoffice', channel: 'latest' },
    ])
  })

  it('marks unsigned mac packages for the manual release-page notice', () => {
    const unsigned = loadBuilder({}, 'darwin')
    expect(unsigned.extraMetadata?.teleofficeMacManualUpdate).toBe(true)
    expect(unsigned.publish?.[0]?.provider).toBe('github')

    const signed = loadBuilder({ CSC_LINK: 'cert.p12' }, 'darwin')
    expect(signed.extraMetadata?.teleofficeMacManualUpdate).toBeUndefined()
    expect(signed.publish?.[0]?.provider).toBe('github')
  })
})
