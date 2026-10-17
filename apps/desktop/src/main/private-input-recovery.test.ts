import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { NativePrivateInputRecovery } from './private-input-recovery'

it('persists separate private bodies and the exact in-flight request across new store instances', () => {
  const root = mkdtempSync(join(tmpdir(), 'rovai-private-input-recovery-'))
  const first = new NativePrivateInputRecovery(root), bodyKey = 'single-chat:thread:canvas:a'
  const intentKey = 'single-chat-input-intent:v1:{"conversationId":"private","contextKey":"a"}'
  const intent = { version: 1, params: { commandId: 'original', command: { body: '原文' } } }
  first.set(bodyKey, { private: '未发送的末字' }); first.set(intentKey, intent)
  const reopened = new NativePrivateInputRecovery(root)
  expect(reopened.get(bodyKey)).toEqual({ found: true, value: { private: '未发送的末字' } })
  expect(reopened.get('single-chat:thread:canvas:b')).toEqual({ found: false })
  expect(reopened.get(intentKey)).toEqual({ found: true, value: intent })
  reopened.set(intentKey, null)
  expect(new NativePrivateInputRecovery(root).get(intentKey)).toEqual({ found: true, value: null })
  expect(readdirSync(root).every(name => /^[a-f0-9]{64}\.json$/.test(name))).toBe(true)
})

it('refuses damaged or mismatched records without replacing the original bytes', () => {
  const root = mkdtempSync(join(tmpdir(), 'rovai-private-input-recovery-'))
  const store = new NativePrivateInputRecovery(root), key = 'single-chat:owned'
  store.set(key, { private: '原文' })
  const path = join(root, createHash('sha256').update(key).digest('hex')+'.json')
  const original = readFileSync(path)
  expect(() => store.set(key, undefined)).toThrow()
  expect(readFileSync(path)).toEqual(original)
  writeFileSync(path, '{broken')
  expect(() => store.get(key)).toThrow()
  expect(() => store.set(key, {})).toThrow()
  expect(readFileSync(path, 'utf8')).toBe('{broken')
  writeFileSync(path, JSON.stringify({version:1, identity:'single-chat:foreign', value:null}))
  expect(() => store.get(key)).toThrow()
  expect(original.length).toBeGreaterThan(0)
})

it('rejects non-private keys and never maps supplied paths directly to files', () => {
  const root = mkdtempSync(join(tmpdir(), 'rovai-private-input-recovery-')), store = new NativePrivateInputRecovery(root)
  for (const key of ['../outside', 'public-input', '', 'single-chat:\0bad']) expect(() => store.set(key, {})).toThrow()
  store.set('single-chat:../../owned', {})
  expect(readdirSync(root)).toHaveLength(1)
  expect(readdirSync(root)[0]).toMatch(/^[a-f0-9]{64}\.json$/)
})
