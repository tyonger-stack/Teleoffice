import { test, expect } from '@playwright/test'
import { copyFile, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { ElectronApplication, Page } from 'playwright-core'
import { launchShell, closeAndSaveVideo, waitForPageWithUrl } from './helpers'

const DOCX = resolve(__dirname, 'assets/justify-pagegap-fr.docx')
const XLSX = resolve(__dirname, '../apps/sheets/fixtures/generated/compatibility-basic.xlsx')

/**
 * A freshly opened document must own the keyboard. The regression had
 * two layers — the shell never handed webContents focus to a tab activated
 * from the Home list (the click sits on the chrome webContents), and the docs
 * editor never focused its body even in a focused view. Both are exercised by
 * the real flow: land on Home, open a file exactly like the Home list does,
 * then type without a single click into the document.
 */

/** the Home-list click that precedes an open leaves keyboard focus on chrome */
async function openFromHome(app: ElectronApplication, home: Page, file: string): Promise<void> {
  await app.evaluate(({ app: electronApp, BrowserWindow }) => {
    electronApp.focus({ steal: true })
    const win = BrowserWindow.getAllWindows()[0]
    win.focus()
    win.webContents.focus()
  })
  // Native window activation is asynchronous (especially between app launches).
  await expect
    .poll(() =>
      app.evaluate(({ BrowserWindow }) => {
        const win = BrowserWindow.getAllWindows()[0]
        return win.isFocused() && win.webContents.isFocused()
      }),
    )
    .toBe(true)
  await home.evaluate(
    (p) =>
      (window as unknown as { aiOffice: { openPath(p: string): Promise<void> } }).aiOffice.openPath(
        p,
      ),
    file,
  )
}

/** the document's editable surface must hold focus before typing */
async function waitForEditableFocus(page: Page): Promise<void> {
  await page.waitForFunction(
    () =>
      document.activeElement instanceof HTMLElement &&
      document.activeElement.isContentEditable &&
      // A node detached from the document still reports isContentEditable as
      // true. A workbook loaded into an already-mounted view rebuilds the
      // editor DOM, and the stale node left under activeElement then passes
      // the two checks above while the typed text goes nowhere.
      document.activeElement.isConnected,
    null,
    { timeout: 30_000 },
  )
}

/** Playwright's keyboard bypasses Electron-level focus, so the shell layer is
 *  asserted directly: the opened document's webContents must hold the window's
 *  keyboard focus (on unfixed code it stays on the Home/chrome webContents). */
async function expectViewFocused(app: ElectronApplication, urlPart: string): Promise<void> {
  await expect
    .poll(() =>
      app.evaluate(
        ({ webContents }, part) =>
          webContents
            .getAllWebContents()
            .filter((wc) => wc.isFocused())
            .map((wc) => wc.getURL())
            .some((u) => u.includes(part)),
        urlPart,
      ),
    )
    .toBe(true)
}

async function cellA1Value(page: Page): Promise<unknown> {
  return page.evaluate(() => {
    const api = (
      window as unknown as {
        __teleofficeDebug: {
          univerAPI: {
            getActiveWorkbook(): {
              getActiveSheet(): { getRange(a: string): { getValue(): unknown } }
            }
          }
        }
      }
    ).__teleofficeDebug.univerAPI
    return api.getActiveWorkbook()?.getActiveSheet()?.getRange('A1')?.getValue() ?? null
  })
}

/** The cell Univer considers active, or null when the sheet has no selection. */
async function activeRangeNotation(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const api = (
      window as unknown as {
        __teleofficeDebug?: {
          univerAPI?: {
            getActiveWorkbook?: () => {
              getActiveSheet?: () => {
                getActiveRange?: () => { getA1Notation?: () => string } | null
              } | null
            } | null
          }
        }
      }
    ).__teleofficeDebug?.univerAPI
    return (
      api?.getActiveWorkbook?.()?.getActiveSheet?.()?.getActiveRange?.()?.getA1Notation?.() ?? null
    )
  })
}

/** center of cell A1: right of the ~46px row header, below the ~24px column header */
async function cellA1Point(page: Page): Promise<{ x: number; y: number }> {
  const grid = await page.evaluate(() => {
    for (const canvas of document.querySelectorAll('canvas')) {
      const rect = canvas.getBoundingClientRect()
      if (rect.width > 500 && rect.height > 300) return { x: rect.x, y: rect.y }
    }
    return null
  })
  if (!grid) throw new Error('worksheet canvas not found')
  return { x: grid.x + 46 + 43, y: grid.y + 24 + 12 }
}

/** Observe an initialized hidden spare before opening a workbook. */
async function waitForSpareViewReady(app: ElectronApplication): Promise<number> {
  let spareId = 0
  await expect
    .poll(
      async () => {
        const spare = await app.evaluate(async ({ BrowserWindow, WebContentsView }) => {
          const view = BrowserWindow.getAllWindows()[0].contentView.children.find(
            (child): child is Electron.WebContentsView =>
              child instanceof WebContentsView &&
              !child.getVisible() &&
              child.webContents.getURL().includes('://sheets/'),
          )
          if (!view || view.getVisible() || view.webContents.isLoading()) return null
          const mounted = await view.webContents.executeJavaScript(`
              window.__teleofficeSpareViewReady?.() === true &&
              document.querySelector('#univer-container canvas') !== null &&
              document.querySelector('#univer-container [contenteditable="true"]') !== null
            `)
          return mounted ? view.webContents.id : null
        })
        if (spare === null) return false
        spareId = spare
        return true
      },
      { timeout: 60_000 },
    )
    .toBe(true)

  return spareId
}

test('docs: typing works immediately after opening a file from Home', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'teleoffice-openfocus-e2e-'))
  const docx = join(scratch, 'open-focus.docx')
  await copyFile(DOCX, docx)

  const launched = await launchShell({ onboardingSeen: true, videoDir: 'open-focus-docs' })
  try {
    await openFromHome(launched.app, launched.page, docx)
    const docs = await waitForPageWithUrl(launched.app, '://docs/')
    await docs.waitForSelector('.ProseMirror', { timeout: 30_000 })
    await expectViewFocused(launched.app, '://docs/')
    await waitForEditableFocus(docs)

    await docs.keyboard.type('ROW226FOCUS')
    await expect
      .poll(() => docs.evaluate(() => document.querySelector('.ProseMirror')?.textContent ?? ''))
      .toContain('ROW226FOCUS')
  } finally {
    await closeAndSaveVideo(launched, 'open-focus-docs')
  }
})

test.describe('sheets spare-view focus', () => {
  test('sheets: typing works when a spare view opens the next workbook', async () => {
    const scratch = await mkdtemp(join(tmpdir(), 'teleoffice-openfocus-e2e-'))
    const firstXlsx = join(scratch, 'first.xlsx')
    const secondXlsx = join(scratch, 'second.xlsx')
    await copyFile(XLSX, firstXlsx)
    await copyFile(XLSX, secondXlsx)

    const launched = await launchShell({
      onboardingSeen: true,
      videoDir: 'open-focus-sheets',
      // Keep prewarming enabled: the focus bug only shows when a spare is reused.
      env: { TELEOFFICE_DEBUG_HOOKS: '1', TELEOFFICE_NO_SPARE_VIEW: '' },
    })
    try {
      await openFromHome(launched.app, launched.page, firstXlsx)
      const firstSheets = await waitForPageWithUrl(launched.app, '://sheets/')
      // Prewarming starts only while Sheets is active. Wait for the hidden
      // replacement to finish initialization before opening the second file.
      const spareId = await waitForSpareViewReady(launched.app)
      const sheets = launched.app
        .windows()
        .find((page) => page !== firstSheets && page.url().includes('://sheets/'))!
      await openFromHome(launched.app, launched.page, secondXlsx)
      await sheets.waitForFunction(
        () =>
          (window as unknown as { __teleofficeDebug?: { univerAPI?: unknown } }).__teleofficeDebug
            ?.univerAPI,
        null,
        { timeout: 60_000 },
      )
      // Shell regression: the adopted spare webContents must own Electron focus
      // (without this, Home/chrome keeps the keyboard and no sheet edit works).
      await expect
        .poll(() =>
          launched.app.evaluate(({ BrowserWindow, WebContentsView }, id) => {
            const win = BrowserWindow.getAllWindows()[0]
            const view = win.contentView.children.find(
              (child): child is Electron.WebContentsView =>
                child instanceof WebContentsView && child.webContents.id === id,
            )
            return {
              visible: view?.getVisible(),
              focused: view?.webContents.isFocused(),
              windowFocused: win.isFocused(),
            }
          }, spareId),
        )
        .toEqual({ visible: true, focused: true, windowFocused: true })
      await expect.poll(() => cellA1Value(sheets)).toBe('Old')
      await expect(sheets.locator('main.app-shell')).toHaveAttribute('aria-busy', 'false')
      await expect.poll(() => activeRangeNotation(sheets), { timeout: 30_000 }).toBe('A1')
      // Re-assert Univer sheet focus after the unit swap, then click A1 the same
      // way the rest of the sheets suite does. Printable keys alone are not a
      // reliable edit-mode entry on an adopted Electron WebContentsView in CI
      // (Enter navigates, but onInputBefore never opens the cell editor); the
      // durable product path is pointer → EditorBridge → type.
      await sheets.evaluate(() => {
        ;(
          window as unknown as { __teleofficeDebug?: { focusSheetGrid?: () => void } }
        ).__teleofficeDebug?.focusSheetGrid?.()
      })
      const a1 = await cellA1Point(sheets)
      await sheets.mouse.click(a1.x, a1.y)
      await expect(sheets.locator('[data-u-comp="defined-name"] input')).toHaveValue('A1')
      await sheets.keyboard.type('4242', { delay: 40 })
      await sheets.keyboard.press('Enter')
      await expect.poll(() => cellA1Value(sheets)).toBe(4242)
    } finally {
      await closeAndSaveVideo(launched, 'open-focus-sheets')
    }
  })
})
