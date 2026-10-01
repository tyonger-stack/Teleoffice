import {
  activeMediaProvider,
  activeSearchProvider,
  cloudToolsEnabled,
  imageGenerationAvailable,
  localCliSettingsOf,
  mediaAnalysisAvailable,
} from '@genoffice/ai-provider'
import { hasGskAuth, localCliStatus, readAiSettingsFile } from '@genoffice/ai-search'
import { aiSettingsPath, prepareCloud } from '../cloud'
import type { CommandDef } from '../registry'
import { appLaunch } from '../resources'

/**
 * What the cloud commands can do on this machine, decided from GenOffice's
 * own settings without a network call: the local agy/mmx CLIs (the default
 * search, image and media backends), a Genspark login with cloud tools on,
 * or a BYOK key. Unkeyed fallbacks in the keyed chain (free Parallel MCP,
 * DuckDuckGo) do not count as configured. Agents check this once before
 * planning work that needs photos or web facts.
 */
export const capabilitiesCommand: CommandDef = {
  name: 'capabilities',
  summary:
    'Report which cloud features (search, image search, image generation, media analysis, speech, video) are configured in GenOffice, and whether the app is installed.',
  usage: 'capabilities',
  async run(_args, ctx) {
    await prepareCloud(ctx.env)
    const settings = readAiSettingsFile(aiSettingsPath(ctx.env))
    const gsk = hasGskAuth() && cloudToolsEnabled(settings)
    const searchProvider = activeSearchProvider(settings)
    const cli = localCliSettingsOf(settings)
    const status = localCliStatus(settings)
    const agyOk = status.agy.found
    const mmxOk = status.mmx.found && status.mmx.credentials !== 'missing'
    const cliOk = (id: 'antigravity' | 'mmx'): boolean => (id === 'mmx' ? mmxOk : agyOk)

    let search: { available: boolean; via: string | null }
    if (searchProvider === 'genspark') {
      search = { available: gsk, via: gsk ? 'genspark' : null }
    } else if (searchProvider === 'local-cli') {
      const available = agyOk || mmxOk
      search = {
        available,
        via: available ? 'local-cli (mmx for Chinese / antigravity for foreign)' : null,
      }
    } else if (searchProvider === 'mmx') {
      search = { available: mmxOk, via: mmxOk ? 'mmx' : null }
    } else if (searchProvider === 'antigravity') {
      search = { available: agyOk, via: agyOk ? 'antigravity' : null }
    } else {
      search = { available: true, via: searchProvider }
    }
    // A selected local search backend with no usable binary falls back to
    // Genspark search when signed in with cloud tools on.
    if (
      !search.available &&
      gsk &&
      !status.agy.found &&
      !status.mmx.found &&
      (searchProvider === 'local-cli' ||
        searchProvider === 'mmx' ||
        searchProvider === 'antigravity')
    ) {
      search = { available: true, via: 'genspark' }
    }
    const keyedImageSearch = searchProvider === 'serper' || searchProvider === 'serply'
    const gskSearch = gsk && searchProvider === 'genspark'
    const imageSearch = gskSearch
      ? { available: true, via: 'genspark' as string | null }
      : keyedImageSearch
        ? { available: true, via: searchProvider as string | null }
        : { available: false, via: null as string | null }

    const via = (byok: string | null | undefined): string | null =>
      byok ? byok : gsk ? 'genspark' : null
    const byokCaps = (
      provider: string,
      available: boolean,
    ): { available: boolean; via: string | null } => ({
      available,
      via: available ? via(provider) : null,
    })
    const localPair = (
      primary: 'antigravity' | 'mmx',
    ): { available: boolean; via: string | null; fallback: string | null } => {
      const other = primary === 'mmx' ? 'antigravity' : 'mmx'
      const available = cliOk(primary) || (cli.fallback && cliOk(other))
      return {
        available,
        via: available ? primary : null,
        // Name the other side only when it is actually usable.
        fallback: available && cli.fallback && cliOk(other) ? other : null,
      }
    }
    // A selected local backend with neither binary present falls back to
    // Genspark when signed in with cloud tools on: report genspark as the
    // effective via. BYOK entries never get this fallback.
    const withGskFallback = <T extends { available: boolean; via: string | null }>(
      entry: T,
    ): T | { available: boolean; via: string | null } =>
      !entry.available && gsk && !status.agy.found && !status.mmx.found
        ? { available: true, via: 'genspark' }
        : entry
    const imageProvider = activeMediaProvider(settings, 'image')
    const imageGeneration =
      imageProvider === 'antigravity' || imageProvider === 'mmx'
        ? withGskFallback(localPair(imageProvider))
        : byokCaps(imageProvider, imageGenerationAvailable(settings, hasGskAuth()))
    const analysisProvider = activeMediaProvider(settings, 'analysis')
    const mediaAnalysis =
      analysisProvider === 'antigravity' || analysisProvider === 'mmx'
        ? withGskFallback(localPair(analysisProvider))
        : byokCaps(analysisProvider, mediaAnalysisAvailable(settings, hasGskAuth()))
    const tts = { available: mmxOk, via: mmxOk ? 'mmx' : null }
    const asrPair = localPair('antigravity')
    const asr = { available: asrPair.available, via: asrPair.via, fallback: asrPair.fallback }
    // agy 1.2.13 has no video tool: without the opt-in it is mmx alone, with
    // an explanatory note instead of an antigravity fallback entry.
    const videoGeneration = cli.agyVideo
      ? localPair('antigravity')
      : {
          available: mmxOk,
          via: mmxOk ? 'mmx' : null,
          fallback: null as string | null,
          note: 'Antigravity CLI (agy 1.2.13) has no video generation tool; set localCli.agyVideo=true to try it first',
        }
    const detail = {
      search,
      image_search: imageSearch,
      image_generation: imageGeneration,
      media_analysis: mediaAnalysis,
      tts,
      asr,
      video_generation: videoGeneration,
      local_cli: {
        available: agyOk || mmxOk,
        agy: status.agy,
        mmx:
          status.mmx.credentials === 'missing'
            ? {
                ...status.mmx,
                hint: 'mmx is not logged in: set MINIMAX_API_KEY in the environment (used via mmx-env) or run `mmx auth login` (writes ~/.mmx/config.json)',
              }
            : status.mmx,
      },
      app: { available: appLaunch(ctx.env) !== null },
      settings_path: aiSettingsPath(ctx.env),
    }
    const on = Object.entries(detail)
      .filter(([k, v]) => k !== 'settings_path' && (v as { available: boolean }).available)
      .map(([k]) => k)
    return {
      summary: on.length
        ? `configured: ${on.join(', ')}`
        : 'no cloud feature configured; the app is not installed',
      detail,
    }
  },
}
