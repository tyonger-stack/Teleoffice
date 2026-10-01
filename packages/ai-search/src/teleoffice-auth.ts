/**
 * Optional residual Genspark API key on disk (`~/.teleoffice/auth.json`).
 *
 * TeleOffice no longer runs a browser login flow. Keys may still come from:
 * - `GSK_API_KEY` (preferred; see `gskApiKey()` in `./gsk.ts`)
 * - a leftover `auth.json` from an older install
 * - `~/.genspark-tool-cli/config.json` (shared CLI login)
 *
 * Device-code login / logout were removed for the local-first product.
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { teleofficeHomeDir } from '@teleoffice/electron-utils/teleoffice-home'
import { asRecord } from './shared'

/** Residual auth.json under the live TeleOffice home (or TELEOFFICE_AUTH_DIR). */
export function teleofficeAuthPath(): string {
  return join(teleofficeHomeDir(), 'auth.json')
}

export interface TeleofficeAuth {
  apiKey: string
  keyId?: string
  accessToken?: string
}

let cachedAuth: TeleofficeAuth | null | undefined

function readAuthFile(): TeleofficeAuth | null {
  try {
    const path = teleofficeAuthPath()
    if (!existsSync(path)) return null
    const raw = asRecord(JSON.parse(readFileSync(path, 'utf-8')))
    if (typeof raw.api_key !== 'string' || !raw.api_key) return null
    return {
      apiKey: raw.api_key,
      ...(typeof raw.key_id === 'string' && raw.key_id ? { keyId: raw.key_id } : {}),
      ...(typeof raw.access_token === 'string' && raw.access_token
        ? { accessToken: raw.access_token }
        : {}),
    }
  } catch {
    return null
  }
}

export function loadTeleofficeAuth(): TeleofficeAuth | null {
  if (cachedAuth === undefined) cachedAuth = readAuthFile()
  return cachedAuth
}

/** Drop the cache so the next read sees a key written by another process. */
export function reloadTeleofficeAuth(): void {
  cachedAuth = undefined
}

/** Residual TeleOffice-named api key; '' when none on disk. */
export function teleofficeApiKey(): string {
  return loadTeleofficeAuth()?.apiKey ?? ''
}

/** Test helper: clear the in-memory cache. */
export function resetTeleofficeAuthCache(): void {
  cachedAuth = undefined
}
