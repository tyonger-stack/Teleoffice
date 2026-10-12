import { test, expect } from '@playwright/test'
import { launchShell, closeAndSaveVideo, screenshotPath } from './helpers'

test.describe('home screen', () => {
  test('shows hero, quick-create cards and tab bar', async () => {
    const launched = await launchShell({ onboardingSeen: true, videoDir: 'home-basics' })
    const { page } = launched
    try {
      await expect(page.locator('.home-hero')).toBeVisible()
      // six AI quick-create cards, Open file, then one template card per format
      await expect(page.locator('.quick-card')).toHaveCount(13)
      await expect(page.locator('.quick-card').nth(0)).toContainText('AI Docs')
      await expect(page.locator('.quick-card').nth(1)).toContainText('AI Sheets')
      await expect(page.locator('.quick-card').nth(2)).toContainText('AI Slides')
      await expect(page.locator('.quick-card').nth(3)).toContainText('AI Markdown')
      await expect(page.locator('.quick-card').nth(4)).toContainText('AI HTML')
      await expect(page.locator('.quick-card').nth(5)).toContainText('AI PDF')
      await expect(page.locator('.quick-card').nth(6)).toContainText('Open')
      await expect(page.locator('.quick-card').nth(7)).toContainText('Docs template')
      await expect(page.locator('.quick-card').nth(8)).toContainText('Sheets template')
      await expect(page.locator('.quick-card').nth(9)).toContainText('PPT template')
      await expect(page.locator('.quick-card').nth(10)).toContainText('Markdown template')
      await expect(page.locator('.quick-card').nth(11)).toContainText('HTML template')
      await expect(page.locator('.quick-card').nth(12)).toContainText('PDF template')
      await expect(page.locator('.tab-bar .tab-item.tab-home')).toBeVisible()
      await page.screenshot({ path: screenshotPath('home-overview') })
    } finally {
      await closeAndSaveVideo(launched, 'home-basics')
    }
  })

  test('renders localized UI when TELEOFFICE_LANG=zh-CN', async () => {
    const launched = await launchShell({
      onboardingSeen: true,
      lang: 'zh-CN',
      videoDir: 'home-zh-cn',
    })
    const { page } = launched
    try {
      await expect(page.locator('.nav-item .nav-label').first()).toHaveText('最近')
      await page.screenshot({ path: screenshotPath('home-zh-cn') })
    } finally {
      await closeAndSaveVideo(launched, 'home-zh-cn')
    }
  })
})
