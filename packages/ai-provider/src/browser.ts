/** Browser-safe settings surface. Keep Node-backed transports out of renderer bundles. */
export type {
  AiLocalCliSettings,
  AiMediaProviderId,
  AiMediaProviderMeta,
  AiProviderConfig,
  AiProviderId,
  AiProviderMeta,
  AiSearchProviderId,
  AiSearchProviderMeta,
  AiSettings,
  CodexModelCatalog,
} from './types'
export {
  AI_PROVIDERS,
  activeProvider,
  cloudToolsEnabled,
  DEFAULT_MAX_OUTPUT_TOKENS,
  MAX_MAX_OUTPUT_TOKENS,
  MIN_MAX_OUTPUT_TOKENS,
  clampMaxOutputTokens,
  defaultAiLocalCliSettings,
  localCliSettingsOf,
  resolveAiLocalCliSettings,
} from './providers'
export { getProviderAdapter, modelLacksVision } from './registry'
export { AI_MEDIA_PROVIDERS, imageGenerationAvailable, mediaAnalysisAvailable } from './media'
export { AI_SEARCH_PROVIDERS } from './search-settings'
