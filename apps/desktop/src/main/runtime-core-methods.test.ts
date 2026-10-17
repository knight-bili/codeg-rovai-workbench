import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { RUNTIME_RENDERER_CORE_METHODS } from './runtime-core-methods'

const mainSource = readFileSync(new URL('./index.ts', import.meta.url), 'utf8')

describe('Runtime Renderer Core method allowlist', () => {
  it('exposes discovery, recovery wake, background ensure, explicit checking, and cancellation', () => {
    expect(RUNTIME_RENDERER_CORE_METHODS).toEqual([
      'runtime.discovery.rescan',
      'runtime.product.ensure',
      'runtime.product.check',
      'runtime.startup.get',
      'member.runtimeEnvironment.get',
      'runtime.environmentLegacy.list',
      'runtime.environmentLegacy.get',
      'runtime.environmentLegacy.acknowledge',
      'runtime.startup.inspect',
      'runtime.startup.check',
      'runtime.startup.save',
      'runtime.networkRecovery.wake',
      'runtime.modelCatalog.open',
      'runtime.pendingExecution.cancel'
    ])
    expect(RUNTIME_RENDERER_CORE_METHODS).not.toContain('core.shutdown')
  })

  it('wakes the same Core recovery check when the operating system resumes', () => {
    expect(mainSource).toContain("powerMonitor.on('resume', wakeNetworkRecoveryAfterSystemResume)")
    expect(mainSource).toContain("core.request('runtime.networkRecovery.wake')")
    expect(mainSource).toContain(
      "powerMonitor.removeListener('resume', wakeNetworkRecoveryAfterSystemResume)"
    )
  })

  it('allows the Single Chat pending-input and scoped-material operations implemented by Core', () => {
    const allowlistStart = mainSource.indexOf('const allowedMethods = new Set<CoreMethod>([')
    const allowlistEnd = mainSource.indexOf('\n])', allowlistStart)
    expect(allowlistStart).toBeGreaterThan(-1)
    expect(allowlistEnd).toBeGreaterThan(allowlistStart)
    for (const method of ['singleChat.pendingInputs.edit', 'singleChat.composerDraft.mutate', 'singleChat.composerDraft.recovery']) {
      expect(mainSource.slice(allowlistStart, allowlistEnd)).toContain(`'${method}'`)
    }
  })

  it('admits the implemented skill packs, canvas and ephemeral terminal operations at Native IPC', () => {
    const start = mainSource.indexOf('const allowedMethods = new Set<CoreMethod>([')
    const end = mainSource.indexOf('\n])', start)
    expect(start).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start)
    const methods = mainSource.slice(start, end)
    for (const method of [
      'skillPacks.list', 'skillPacks.read', 'skillPacks.installations.list', 'skillPacks.install', 'skillPacks.uninstall', 'skillPacks.members.list', 'skillPacks.members.set',
      'canvas.boards.list', 'canvas.boards.get', 'canvas.boards.create', 'canvas.boards.update', 'canvas.boards.delete',
      'canvas.nodes.snapshot', 'canvas.nodes.apply', 'canvas.references.page',
      'canvas.terminals.start', 'canvas.terminals.snapshot', 'canvas.terminals.write', 'canvas.terminals.resize', 'canvas.terminals.stop'
    ]) expect(methods).toContain(`'${method}'`)
    expect(methods).not.toContain("'core.shutdown'")
  })
})
