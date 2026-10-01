import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { isTeleofficeLauncher, mcpSnippet, readMcpEntry, writeMcpEntry } from '../src/agent-mcp'
import { mcpLaunch, mcpLaunchFromLauncher, type McpLaunch } from '../src/mcp-launch'
import { tempDir } from './helpers'

const WIN_DIR = 'C:\\Users\\Jane Doe\\AppData\\Local\\Programs\\TeleOffice\\resources\\cli'
const WIN_APP: McpLaunch = {
  command: `${WIN_DIR}\\..\\..\\TeleOffice.exe`,
  args: [`${WIN_DIR}\\teleoffice.cjs`, 'mcp'],
  env: { ELECTRON_RUN_AS_NODE: '1' },
}

describe('mcp launch entry', () => {
  it('is the absolute launcher on macOS and Linux', () => {
    expect(
      mcpLaunchFromLauncher('/Applications/TeleOffice.app/Contents/Resources/cli/teleoffice'),
    ).toEqual({
      command: '/Applications/TeleOffice.app/Contents/Resources/cli/teleoffice',
      args: ['mcp'],
    })
  })

  it('runs the packaged Windows app as Node on the bundle, exactly as the app snippet does', () => {
    const exists = (p: string) => p === `${WIN_DIR}\\..\\..\\TeleOffice.exe`
    const fromCli = mcpLaunchFromLauncher(`${WIN_DIR}\\teleoffice.cmd`, { exists })
    expect(fromCli).toEqual(WIN_APP)
    expect(fromCli).toEqual(mcpLaunch({ status: 'missing', launcherDir: WIN_DIR }))
    expect(fromCli).toEqual(mcpLaunch({ status: 'present', launcherDir: WIN_DIR }))
  })

  it('runs a Windows checkout on the system node with the built bundle', () => {
    const dir = 'D:\\src\\teleoffice\\packages\\cli\\bin'
    expect(mcpLaunchFromLauncher(`${dir}\\teleoffice`, { exists: () => false })).toEqual({
      command: 'node',
      args: [`${dir}\\..\\dist\\teleoffice.cjs`, 'mcp'],
    })
    expect(
      mcpLaunchFromLauncher('/mnt/src/packages/cli/bin/teleoffice', {
        platform: 'win32',
        exists: (p) => p.endsWith('/bin/teleoffice.cjs'),
      }),
    ).toEqual({ command: 'node', args: ['/mnt/src/packages/cli/bin/teleoffice.cjs', 'mcp'] })
  })

  it('recognises every launcher shape as ours', () => {
    expect(isTeleofficeLauncher('/opt/TeleOffice/resources/cli/teleoffice')).toBe(true)
    expect(isTeleofficeLauncher('C:\\TeleOffice\\resources\\cli\\teleoffice.cmd')).toBe(true)
    expect(isTeleofficeLauncher('C:\\Program Files\\TeleOffice\\TeleOffice.exe')).toBe(true)
    expect(isTeleofficeLauncher(WIN_APP.command, WIN_APP.args)).toBe(true)
    expect(
      isTeleofficeLauncher('node', ['C:\\src\\packages\\cli\\dist\\teleoffice.cjs', 'mcp']),
    ).toBe(true)
    expect(isTeleofficeLauncher('npx', ['-y', 'other-mcp'])).toBe(false)
    expect(isTeleofficeLauncher(null)).toBe(false)
  })

  it('carries env in every config format', () => {
    const home = tempDir()
    for (const d of ['.cursor', '.gemini', '.copilot', '.codex', 'opencode'])
      mkdirSync(join(home, d))
    const cursor = join(home, '.cursor', 'mcp.json')
    writeMcpEntry('cursor', cursor, WIN_APP)
    expect(JSON.parse(readFileSync(cursor, 'utf-8')).mcpServers.teleoffice).toEqual({
      type: 'stdio',
      ...WIN_APP,
    })
    const gemini = join(home, '.gemini', 'settings.json')
    writeMcpEntry('gemini', gemini, WIN_APP)
    expect(JSON.parse(readFileSync(gemini, 'utf-8')).mcpServers.teleoffice).toEqual(WIN_APP)
    const copilot = join(home, '.copilot', 'mcp-config.json')
    writeMcpEntry('copilot', copilot, WIN_APP)
    expect(JSON.parse(readFileSync(copilot, 'utf-8')).mcpServers.teleoffice).toEqual({
      type: 'local',
      ...WIN_APP,
      tools: ['*'],
    })
    const opencode = join(home, 'opencode', 'opencode.json')
    writeMcpEntry('opencode', opencode, WIN_APP)
    expect(JSON.parse(readFileSync(opencode, 'utf-8')).mcp.teleoffice).toEqual({
      type: 'local',
      command: [WIN_APP.command, ...WIN_APP.args],
      enabled: true,
      environment: WIN_APP.env,
    })
    const codex = join(home, '.codex', 'config.toml')
    writeFileSync(codex, '[mcp_servers.other]\ncommand = "npx"\n')
    writeMcpEntry('codex', codex, WIN_APP)
    expect(readFileSync(codex, 'utf-8')).toBe(
      '[mcp_servers.other]\ncommand = "npx"\n\n' +
        `[mcp_servers.teleoffice]\ncommand = ${JSON.stringify(WIN_APP.command)}\nargs = ${JSON.stringify(WIN_APP.args)}\n\n` +
        '[mcp_servers.teleoffice.env]\nELECTRON_RUN_AS_NODE = "1"\n',
    )
    for (const [id, file] of [
      ['cursor', cursor],
      ['gemini', gemini],
      ['copilot', copilot],
      ['opencode', opencode],
      ['codex', codex],
    ] as const) {
      expect(readMcpEntry(id, file, WIN_APP).status, id).toBe('registered')
      expect(
        readMcpEntry(id, file, { command: '/elsewhere/cli/teleoffice', args: ['mcp'] }).status,
        id,
      ).toBe('stale')
    }
    expect(mcpSnippet('codex', WIN_APP)).toContain('[mcp_servers.teleoffice.env]')
  })

  it('treats the app snippet entry (TeleOffice.exe on teleoffice.cjs) as ours, not occupied', () => {
    const home = tempDir()
    const file = join(home, 'mcp.json')
    writeFileSync(file, JSON.stringify({ mcpServers: { teleoffice: WIN_APP } }))
    const posix = { command: '/opt/TeleOffice/resources/cli/teleoffice', args: ['mcp'] }
    expect(readMcpEntry('cursor', file, posix)).toEqual({
      status: 'stale',
      command: WIN_APP.command,
    })
    writeFileSync(
      file,
      JSON.stringify({
        mcpServers: { teleoffice: { command: 'node', args: ['/src/dist/teleoffice.cjs', 'mcp'] } },
      }),
    )
    expect(readMcpEntry('cursor', file, posix).status).toBe('stale')
    const toml = join(home, 'config.toml')
    writeFileSync(
      toml,
      `[mcp_servers.teleoffice]\ncommand = ${JSON.stringify(WIN_APP.command)}\nargs = ${JSON.stringify(WIN_APP.args)}\n[mcp_servers.teleoffice.env]\nELECTRON_RUN_AS_NODE = "1"\n`,
    )
    expect(readMcpEntry('codex', toml, posix).status).toBe('stale')
    expect(readMcpEntry('codex', toml, WIN_APP).status).toBe('registered')
  })
})
