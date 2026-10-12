import { createRoot } from 'react-dom/client'
import { htmlLang, type Lang } from '@teleoffice/i18n'
import App from './App'
import { LocaleProvider } from './i18n/locale'
import type { UiTheme } from '../shared/ipc'
import '@teleoffice/ui/tokens.css'
import '@teleoffice/ui/screentip.css'
import '@teleoffice/ui/dropdown.css'
import '@teleoffice/ui/find-panel.css'
import '@teleoffice/ui/ai-usage.css'
import '@teleoffice/ui/ribbon-collapse.css'
import '@teleoffice/ui/markdown.css'
import '@teleoffice/ui/ai-panel-prefs.css'
import '@teleoffice/ui/ai-scope-quote.css'
import '@teleoffice/ui/image-viewer.css'
import 'katex/dist/katex.min.css'
import './styles.css'
import { applyAiPanelPrefs, installScreenTips } from '@teleoffice/ui'

installScreenTips()

function applyTheme(theme: UiTheme): void {
  if (theme === 'system') document.documentElement.removeAttribute('data-theme')
  else document.documentElement.setAttribute('data-theme', theme)
}

void (async () => {
  const [lang, theme] = await Promise.all([
    window.markdownApi.getLanguage().catch(() => 'zh' as const),
    window.markdownApi.getTheme().catch(() => 'system' as const),
  ])
  document.documentElement.lang = htmlLang(lang as Lang)
  applyTheme(theme)
  window.markdownApi.onThemeChanged(applyTheme)
  await window.markdownApi
    ?.getAiPanelPrefs?.()
    .then(applyAiPanelPrefs)
    .catch(() => {})
  window.markdownApi?.onAiPanelPrefsChanged?.(applyAiPanelPrefs)
  createRoot(document.getElementById('root')!).render(
    <LocaleProvider initial={lang}>
      <App />
    </LocaleProvider>,
  )
})()
