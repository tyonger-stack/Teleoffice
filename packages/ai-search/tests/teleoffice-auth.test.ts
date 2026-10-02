/**
 * Residual auth.json reader — login/logout flows were removed (local-first).
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  loadTeleofficeAuth,
  reloadTeleofficeAuth,
  resetTeleofficeAuthCache,
  teleofficeApiKey,
  teleofficeAuthPath,
} from '../src/teleoffice-auth'
import { gskApiKey } from '../src/gsk'

let dir: string
const prevAuthDir = process.env.TELEOFFICE_AUTH_DIR
const prevGskKey = process.env.GSK_API_KEY

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'teleoffice-auth-'))
  process.env.TELEOFFICE_AUTH_DIR = dir
  delete process.env.GSK_API_KEY
  resetTeleofficeAuthCache()
})

afterEach(() => {
  resetTeleofficeAuthCache()
  if (prevAuthDir === undefined) delete process.env.TELEOFFICE_AUTH_DIR
  else process.env.TELEOFFICE_AUTH_DIR = prevAuthDir
  if (prevGskKey === undefined) delete process.env.GSK_API_KEY
  else process.env.GSK_API_KEY = prevGskKey
  rmSync(dir, { recursive: true, force: true })
})

describe('teleoffice auth.json reader', () => {
  it('returns null when no auth file exists', () => {
    expect(loadTeleofficeAuth()).toBeNull()
    expect(teleofficeApiKey()).toBe('')
  })

  it('reads api_key from auth.json', () => {
    writeFileSync(
      teleofficeAuthPath(),
      JSON.stringify({ api_key: 'gsk-residual', key_id: 'kid-1' }),
    )
    expect(loadTeleofficeAuth()).toEqual({ apiKey: 'gsk-residual', keyId: 'kid-1' })
    expect(teleofficeApiKey()).toBe('gsk-residual')
  })

  it('feeds gskApiKey behind GSK_API_KEY env', () => {
    writeFileSync(teleofficeAuthPath(), JSON.stringify({ api_key: 'gsk-residual' }))
    reloadTeleofficeAuth()
    expect(gskApiKey()).toBe('gsk-residual')
    process.env.GSK_API_KEY = 'gsk-env'
    expect(gskApiKey()).toBe('gsk-env')
  })

  it('reloadTeleofficeAuth picks up a rewritten file', () => {
    writeFileSync(teleofficeAuthPath(), JSON.stringify({ api_key: 'gsk-old' }))
    expect(teleofficeApiKey()).toBe('gsk-old')
    writeFileSync(teleofficeAuthPath(), JSON.stringify({ api_key: 'gsk-new' }))
    reloadTeleofficeAuth()
    expect(teleofficeApiKey()).toBe('gsk-new')
  })
})
