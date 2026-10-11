import { test, expect } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launchShell, closeAndSaveVideo, screenshotPath } from './helpers'

test.describe('first-run onboarding', () => {
  test('fresh install shows the welcome and persists the seen flag', async () => {
    const launched = await launchShell({ videoDir: 'onboarding-walkthrough' })
    const { page, userDataDir } = launched
    try {
      const overlay = page.locator('.onb-overlay')
      await expect(overlay).toBeVisible()
      await expect(page.locator('.onb-slide.active .onb-title')).toHaveText('Welcome to TeleOffice')
      await expect(page.locator('.onb-skip')).toHaveCount(0)
      await expect(page.locator('.onb-next')).toHaveText('Get started')
      await page.screenshot({ path: screenshotPath('onboarding-slide-1') })

      // the only slide's primary button finishes the welcome
      await page.locator('.onb-next').click()
      await expect(overlay).toBeHidden()
      await expect(page.locator('.home-hero')).toBeVisible()
      await page.screenshot({ path: screenshotPath('onboarding-done-home') })

      await expect
        .poll(async () => {
          const raw = await readFile(join(userDataDir, 'app-settings.json'), 'utf8')
          return (JSON.parse(raw) as { onboardingSeen?: boolean }).onboardingSeen
        })
        .toBe(true)
    } finally {
      await closeAndSaveVideo(launched, 'onboarding-walkthrough')
    }

    // second launch with the same userData must not show the onboarding again
    const relaunch = await launchShell({
      userDataDir: launched.userDataDir,
      videoDir: 'onboarding-relaunch',
    })
    try {
      await expect(relaunch.page.locator('.home-hero')).toBeVisible()
      await expect(relaunch.page.locator('.onb-overlay')).toHaveCount(0)
      await relaunch.page.screenshot({ path: screenshotPath('onboarding-relaunch-no-overlay') })
    } finally {
      await closeAndSaveVideo(relaunch, 'onboarding-relaunch')
    }
  })

  test('Escape dismisses the welcome and persists the seen flag', async () => {
    const launched = await launchShell({ videoDir: 'onboarding-skip' })
    const { page, userDataDir } = launched
    try {
      await expect(page.locator('.onb-overlay')).toBeVisible()
      await expect(page.locator('.onb-skip')).toHaveCount(0)
      await page.keyboard.press('Escape')
      await expect(page.locator('.onb-overlay')).toBeHidden()
      await page.screenshot({ path: screenshotPath('onboarding-skipped-home') })

      await expect
        .poll(async () => {
          const raw = await readFile(join(userDataDir, 'app-settings.json'), 'utf8')
          return (JSON.parse(raw) as { onboardingSeen?: boolean }).onboardingSeen
        })
        .toBe(true)
    } finally {
      await closeAndSaveVideo(launched, 'onboarding-skip')
    }
  })
})
