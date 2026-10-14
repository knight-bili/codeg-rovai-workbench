import assert from 'node:assert/strict'
import test from 'node:test'
import { configureProductRuntime } from '../configure-product-runtime.mjs'

// Owns the acceptance helper's member-readiness/probe distinction. No process,
// SQLite, provider, Runtime turn or model qualification belongs to this test.
test('Runtime configuration accepts current static member bindings without weakening probe checks', async t => {
  for (const scenario of [
    { kind: 'qwen-code', readiness: 'installed_unverified', probe: 'ready', allowed: true },
    { kind: 'codex-cli', readiness: 'installed_unverified', probe: 'ready', allowed: true },
    { kind: 'qwen-code', readiness: 'ready', probe: 'ready', allowed: true },
    { kind: 'opencode-cli', readiness: 'installed_unverified', probe: 'light_ready', allowed: true },
    { kind: 'qwen-code', readiness: 'installed_unverified', probe: 'light_ready', allowed: false },
    { kind: 'qwen-code', readiness: 'installed_unverified', probe: 'error', allowed: false },
    { kind: 'qwen-code', readiness: 'needs_attention', probe: 'ready', allowed: false }
  ]) {
    await t.test(`${scenario.kind}/${scenario.readiness}/${scenario.probe}`, async () => {
      const calls = [], writes = []
      let checks = 0
      const model = { mode: 'runtime_default' }
      const permissions = { adapterKind: scenario.kind, schemaVersion: 1, values: {} }
      const installation = { id: 'owned', adapterKind: scenario.kind, installationClass: 'managed_default',
        authScope: 'default', memberRuntimeDefaults: { model, permissions }, snapshot: { probeStatus: scenario.probe } }
      const request = async (method, params) => {
        calls.push(method)
        if (method === 'runtime.product.check') {
          if (++checks > 1) throw Error('Do not repeatedly rewrite a valid static binding')
          return {}
        }
        if (method === 'runtime.installations.list') return [
          { ...installation, installationClass: 'additional', id: 'other' }, installation
        ]
        if (method === 'members.get') return { version: 7,
          runtimeConfiguration: { adapterKind: scenario.kind },
          runtimeReadiness: { status: scenario.readiness, blockers: [] } }
        if (method === 'members.runtime.set') {
          writes.push(params)
          return { status: 'applied' }
        }
        throw Error(`Unexpected operation: ${method}`)
      }
      if (scenario.allowed) {
        assert.equal(await configureProductRuntime(request, scenario.kind, ['member-owned']), installation)
        assert.equal(checks, 1)
      } else {
        await assert.rejects(configureProductRuntime(request, scenario.kind, ['member-owned']),
          /Managed Product Runtime is not ready|Do not repeatedly rewrite/)
      }
      assert.equal(writes.length, 1)
      assert.deepEqual(writes[0].command, { agentId: 'member-owned', expectedVersion: 7,
        adapterKind: scenario.kind, model, permissions })
      assert.equal(typeof writes[0].commandId, 'string')
      assert.equal(calls.some(method => method.includes('prompt') || method.includes('messages.send')), false)
    })
  }
})
