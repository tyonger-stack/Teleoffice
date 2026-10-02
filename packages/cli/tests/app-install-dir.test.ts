import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { appBinaryForResources } from '../src/resources'

describe('appBinaryForResources', () => {
  it('finds the app in a custom Windows install directory', () => {
    expect(appBinaryForResources(join('D:\\Apps\\TeleOffice', 'resources'), 'win32')).toBe(
      join('D:\\Apps\\TeleOffice', 'TeleOffice.exe'),
    )
  })

  it('resolves the same binary for the default Windows install directory', () => {
    const localAppData = 'C:\\Users\\test\\AppData\\Local'
    const resources = join(localAppData, 'Programs', 'TeleOffice', 'resources')
    expect(appBinaryForResources(resources, 'win32')).toBe(
      join(localAppData, 'Programs', 'TeleOffice', 'TeleOffice.exe'),
    )
  })

  it('finds the app in a custom macOS bundle location', () => {
    expect(
      appBinaryForResources(join('/Volumes/Work/TeleOffice.app/Contents/Resources'), 'darwin'),
    ).toBe(join('/Volumes/Work/TeleOffice.app/Contents/MacOS/TeleOffice'))
  })

  it('finds the app in a custom Linux prefix', () => {
    expect(appBinaryForResources(join('/opt/teleoffice-custom/resources'), 'linux')).toBe(
      join('/opt/teleoffice-custom/teleoffice'),
    )
  })
})
