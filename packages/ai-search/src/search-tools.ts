/**
 * ai:web-search / ai:image-search for the editors' main processes: reads
 * ai-settings.json live and turns the search provider choice into
 * SearchOptions — Genspark keeps the historic chain (gsk when signed in and
 * cloud tools are on, then env keys, then free Parallel MCP, then DuckDuckGo);
 * a selected custom provider runs first and skips gsk; a selected local CLI
 * provider routes to agy/mmx first, then the free chain (gsk skipped).
 */

import {
  activeSearchProvider,
  cloudToolsEnabled,
  defaultAiLocalCliSettings,
  type AiSearchProviderId,
  type AiSettings,
} from '@teleoffice/ai-provider'
import { imageSearch, webSearch, type SearchOptions } from './index'
import { readAiSettingsFile } from './media-tools'

export function searchOptionsFromSettings(settings: AiSettings): SearchOptions {
  const provider = activeSearchProvider(settings)
  if (provider === 'genspark') return { useGsk: cloudToolsEnabled(settings) }
  if (provider === 'local-cli' || provider === 'mmx' || provider === 'antigravity') {
    return { useGsk: false, localCli: { provider, settings } }
  }
  const key = settings.search!.providers?.[provider]?.apiKey?.trim() ?? ''
  if (provider === 'parallel') return { useGsk: false, parallelKey: key, prefer: 'parallel' }
  if (provider === 'serply') return { useGsk: false, serplyKey: key, prefer: 'serply' }
  if (provider === 'exa') return { useGsk: false, exaKey: key, prefer: 'exa' }
  if (provider === 'firecrawl') return { useGsk: false, firecrawlKey: key, prefer: 'firecrawl' }
  return provider === 'tavily'
    ? { useGsk: false, tavilyKey: key, prefer: 'tavily' }
    : { useGsk: false, serperKey: key }
}

export function webSearchTool(
  settingsPath: string,
  query: string,
  maxResults = 6,
  opts?: { via?: string },
) {
  const options = searchOptionsFromSettings(readAiSettingsFile(settingsPath))
  if (opts?.via !== undefined && options.localCli) {
    options.localCli = { ...options.localCli, via: opts.via }
  }
  return webSearch(query, maxResults, options)
}

export function imageSearchTool(settingsPath: string, query: string, maxResults = 8) {
  return imageSearch(query, maxResults, searchOptionsFromSettings(readAiSettingsFile(settingsPath)))
}

/**
 * settings-UI test: the selected backend must answer one minimal query.
 * Local CLI backends run one tiny real search (foreign for agy, Chinese for mmx).
 */
export async function testSearchProvider(
  provider: AiSearchProviderId,
  apiKey: string,
  settings?: Pick<AiSettings, 'localCli'>,
): Promise<{ ok: boolean; error?: string }> {
  if (provider === 'genspark') return { ok: true }
  if (provider === 'local-cli' || provider === 'mmx' || provider === 'antigravity') {
    const query = provider === 'mmx' ? '深圳天气' : 'TeleOffice'
    // mmx/antigravity must answer by themselves: no fallback, and the method
    // has to match, so a dead mmx cannot pass on agy's back. local-cli keeps
    // the auto routing with fallback.
    const r = await webSearch(query, 1, {
      useGsk: false,
      localCli: {
        provider,
        settings:
          provider === 'local-cli'
            ? (settings ?? null)
            : {
                localCli: {
                  ...defaultAiLocalCliSettings(),
                  ...settings?.localCli,
                  fallback: false,
                },
              },
        ...(provider === 'local-cli' ? {} : { via: provider }),
      },
    })
    if (provider === 'local-cli') {
      if (r.method === 'mmx' || r.method === 'antigravity') return { ok: true }
    } else if (r.method === provider) {
      return { ok: true }
    }
    return {
      ok: false,
      error:
        r.method === 'error'
          ? (r.error ?? 'search failed')
          : `${provider} did not answer (unavailable); fell back to ${r.method}`,
    }
  }
  apiKey = apiKey.trim()
  if (!apiKey && provider !== 'parallel') return { ok: false, error: 'API key is empty' }
  const options: SearchOptions = {
    useGsk: false,
    serperKey: provider === 'serper' ? apiKey : '',
    serplyKey: provider === 'serply' ? apiKey : '',
    tavilyKey: provider === 'tavily' ? apiKey : '',
    parallelKey: provider === 'parallel' ? apiKey : '',
    exaKey: provider === 'exa' ? apiKey : '',
    firecrawlKey: provider === 'firecrawl' ? apiKey : '',
    prefer: provider,
  }
  const r = await webSearch('TeleOffice', 1, options)
  if (r.method === provider) return { ok: true }
  return {
    ok: false,
    error:
      r.method === 'error'
        ? (r.error ?? 'search failed')
        : `${provider} did not answer (service unavailable, key rejected or quota exhausted); fell back to ${r.method}`,
  }
}
