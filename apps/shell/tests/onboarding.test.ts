/**
 * @vitest-environment jsdom
 */
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Onboarding } from '../src/renderer/src/Onboarding'
import { LocaleProvider } from '../src/renderer/src/locale'

const actEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean
}
actEnvironment.IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

function renderOnboarding(onDone: () => Promise<boolean>): void {
  act(() => {
    root.render(
      createElement(LocaleProvider, { initial: 'en' }, createElement(Onboarding, { onDone })),
    )
  })
}

async function click(selector: string): Promise<void> {
  const button = host.querySelector<HTMLButtonElement>(selector)
  expect(button).not.toBeNull()
  await act(async () => {
    button!.click()
    await Promise.resolve()
  })
}

describe('first-run welcome copy', () => {
  it('shows the TeleOffice welcome lines and keeps the original body style', () => {
    act(() => {
      root.render(
        createElement(
          LocaleProvider,
          { initial: 'zh' },
          createElement(Onboarding, { onDone: vi.fn(async () => true) }),
        ),
      )
    })

    expect(host.querySelector('.onb-title')?.textContent).toBe('欢迎使用TeleOffice')
    expect(host.querySelector('.onb-subtitle')?.textContent).toBe('TeleOffice是AI原生Office套件')
    const body = host.querySelector('.onb-body')
    expect(body?.textContent).toBe('创建文档、制作表格、生成演示、审阅 PDF。AI 深度融入每个环节。')
    expect(body?.className).toBe('onb-body')
  })
})

describe('first-run welcome dialog', () => {
  it('shows the welcome slide without a skip control', () => {
    renderOnboarding(vi.fn(async () => true))
    expect(host.querySelector('[role="switch"]')).toBeNull()
    expect(host.querySelector('.onb-skip')).toBeNull()
    expect(host.textContent).not.toContain('Enabled by default')
  })

  it('lets Escape finish the welcome', async () => {
    const onDone = vi.fn(async () => true)
    renderOnboarding(onDone)

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
      await Promise.resolve()
    })
    expect(onDone).toHaveBeenCalledOnce()
  })

  it('finishes from the start button', async () => {
    const onDone = vi.fn(async () => true)
    renderOnboarding(onDone)

    await click('.onb-next')
    await click('.onb-next')
    await click('.onb-next')
    expect(onDone).toHaveBeenCalledWith()
  })
})
