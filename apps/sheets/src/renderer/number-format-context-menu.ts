/**
 * Minimal Excel-parity "Number Format" entry on the cell right-click menu.
 *
 * Upstream ships the full cell-context-menu port (Paste Special…, Filter ▸,
 * Number Format ▸, Format Cells…, …). This release branch does not carry that
 * port; without at least the Number Format label the #2045 mixed-theme e2e
 * canary has nothing to read. Register a single visible button so the menu
 * surface contrast check (genoffice#2041 / #2045) still has a stable canary.
 */
import { LocaleService, UniverInstanceType } from '@univerjs/core'
import type { IAccessor, IDisposable, ILocales } from '@univerjs/core'
import {
  ContextMenuGroup,
  ContextMenuPosition,
  IMenuManagerService,
  MenuItemType,
  getMenuHiddenObservable,
} from '@univerjs/ui'

import type { UniverRuntime } from './univer-state'

export const NUMBER_FORMAT_MENU_ID = 'teleoffice.ctx.number-format'
const LOCALE_NAMESPACE = 'teleofficeCtx'
const TITLE_KEY = 'numberFormat'
const TITLE = 'Number Format'

export function installNumberFormatContextMenu(runtime: UniverRuntime): IDisposable {
  const injector = runtime.univer.__getInjector()
  const localeService = injector.get(LocaleService)
  localeService.load({
    [localeService.getCurrentLocale()]: {
      [LOCALE_NAMESPACE]: { [TITLE_KEY]: TITLE },
    },
  } as unknown as ILocales)

  injector.get(IMenuManagerService).mergeMenu({
    [ContextMenuPosition.MAIN_AREA]: {
      [ContextMenuGroup.OTHERS]: {
        [NUMBER_FORMAT_MENU_ID]: {
          order: 1,
          menuItemFactory: (accessor: IAccessor) => ({
            id: NUMBER_FORMAT_MENU_ID,
            type: MenuItemType.BUTTON,
            title: `${LOCALE_NAMESPACE}.${TITLE_KEY}`,
            hidden$: getMenuHiddenObservable(accessor, UniverInstanceType.UNIVER_SHEET),
          }),
        },
      },
    },
  })

  return { dispose() {} }
}
