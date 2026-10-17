import { afterEach, describe, expect, it, vi } from 'vitest'
import { CanvasNotificationVisibility, canvasNotificationNodeVisible, intersectNotificationRects, observeCanvasNotificationVisibility } from './canvas-notification-visibility'
const source = (threadId: string, messageId: string, conversationId: string | null = null) => ({ threadId, conversationId,
  surfaceVisible: true, snapshotSequence: 10, messageIds: [messageId], campTurnIds: [], agentRunIds: [], approvalIds: [] })
afterEach(() => vi.unstubAllGlobals())

describe('canvas visibility reports', () => {
  it('rechecks window attention and rejects reports whose real frame is gone before dispatch', () => {
    const store = new CanvasNotificationVisibility()
    store.register('first', 'a').publish('public', source('a', 'message'))
    vi.stubGlobal('document', { visibilityState: 'hidden', hasFocus: () => true })
    expect(store.readVisibleSources()).toEqual([])
    vi.stubGlobal('document', { visibilityState: 'visible', hasFocus: () => false })
    expect(store.readVisibleSources()).toEqual([])
    vi.stubGlobal('document', { visibilityState: 'visible', hasFocus: () => true, querySelectorAll: () => [] })
    expect(store.readVisibleSources()).toEqual([])
    expect(store.getSnapshot()[0].messageIds).toEqual(['message'])
  })
  it('retains both mirrors and private reports while closing only their own lease', () => {
    const store = new CanvasNotificationVisibility(), first = store.register('first', 'a'), mirror = store.register('mirror', 'a'), other = store.register('other', 'b')
    first.publish('public', source('a', 'first')); mirror.publish('public', source('a', 'mirror')); other.publish('private', source('b', 'private', 'conversation-b'))
    const reports = store.getSnapshot()
    expect(reports).toHaveLength(3)
    first.release()
    expect(store.getSnapshot().map(s => s.messageIds[0])).toEqual(['mirror', 'private'])
    expect(reports).toHaveLength(3)
    other.release(); expect(store.getSnapshot()[0].threadId).toBe('a')
  })
  it('rejects foreign Thread reports and late publication/cleanup from replaced mounts', () => {
    const store = new CanvasNotificationVisibility(), old = store.register('same-card', 'a'), current = store.register('same-card', 'b')
    old.publish('public', source('a', 'old')); current.publish('public', source('a', 'foreign')); old.release()
    expect(store.getSnapshot()).toEqual([])
    current.publish('public', source('b', 'current')); old.release()
    expect(store.getSnapshot()[0].messageIds).toEqual(['current'])
  })
  it('clones reports and avoids publishing unchanged snapshots', () => {
    const store = new CanvasNotificationVisibility(), card = store.register('first', 'a'), input = source('a', 'message')
    let updates = 0; const stop = store.subscribe(() => updates++)
    card.publish('public', input); const stable = store.getSnapshot()
    card.publish('public', input); input.messageIds.push('later')
    expect(store.getSnapshot()).toBe(stable); expect(stable[0].messageIds).toEqual(['message']); expect(updates).toBe(1)
    stop(); card.release(); expect(updates).toBe(1)
  })
  it('keeps separate client-owned registries even with identical context keys', () => {
    const first = new CanvasNotificationVisibility(), next = new CanvasNotificationVisibility()
    first.register('same', 'a').publish('public', source('a', 'old'))
    expect(next.getSnapshot()).toEqual([])
  })
})
it('clips transformed cards and nested scroll bounds to the window, excluding zero-area edges', () => {
  const window = { left: 0, top: 0, right: 100, bottom: 100 }
  expect(intersectNotificationRects([window, {left: 90, top: 50, right: 200, bottom: 200}])).toEqual({left:90,top:50,right:100,bottom:100})
  expect(intersectNotificationRects([window, {left: 100, top: 0, right: 200, bottom: 100}])).toBeNull()
  expect(intersectNotificationRects([window, {left: 10, top: 10, right: 90, bottom: 90}, {left: 20, top: 20, right: 30, bottom: 30}])).toEqual({left:20,top:20,right:30,bottom:30})
})

function frameFixture(key: string, top = 0) {
  const bounds = { left: 0, right: 300, top, bottom: top + 20 }
  const frame = { dataset: { canvasConversationKey: key }, parentElement: null, hidden: false, inert: false,
    getBoundingClientRect: () => bounds, getClientRects: () => [bounds], closest: () => frame,
    contains: (hit: unknown) => hit === frame || hit === message,
    querySelectorAll: (selector: string) => selector === '[data-message-id]' ? [message] : [] }
  const message = { parentElement: frame, getBoundingClientRect: () => bounds, getClientRects: () => [bounds],
    closest: () => frame, contains: (hit: unknown) => hit === message, getAttribute: () => key }
  return { frame: frame as unknown as HTMLElement, message: message as unknown as HTMLElement, bounds }
}
const visibleStyle = () => ({ visibility: 'visible', opacity: '1', overflowX: 'visible', overflowY: 'visible' })

it('keeps a private Run exact and excludes covered or unmounted reply sources', () => {
  const row = frameFixture('run-1'), store = new CanvasNotificationVisibility()
  row.frame.querySelectorAll = ((selector: string) => selector === '[data-agent-run-id]' ? [row.message] : []) as unknown as typeof row.frame.querySelectorAll
  const owner = store.register('run-1', 'thread-1')
  owner.publish('private', { ...source('thread-1', '', 'private-1'), messageIds: [], agentRunIds: ['run-1', 'unmounted-run'] })
  let covered = false
  vi.stubGlobal('getComputedStyle', visibleStyle)
  vi.stubGlobal('window', { innerWidth: 600, innerHeight: 800 })
  vi.stubGlobal('document', { visibilityState: 'visible', hasFocus: () => true, querySelectorAll: () => [row.frame],
    elementFromPoint: () => covered ? {} : row.message })
  expect(store.readVisibleSources()[0]).toMatchObject({ conversationId: 'private-1', agentRunIds: ['run-1'] })
  covered = true
  expect(store.readVisibleSources()[0]).toMatchObject({ surfaceVisible: false, agentRunIds: [] })
  owner.release()
  expect(store.readVisibleSources()).toEqual([])
})

it('excludes keyboard-covered messages and clips zoomed/panned CSS coordinates to the visual viewport', () => {
  const { message, bounds } = frameFixture('message', 500)
  const hit = vi.fn(() => message)
  vi.stubGlobal('getComputedStyle', visibleStyle)
  vi.stubGlobal('document', { elementFromPoint: hit })
  const viewport = { offsetLeft: 80, offsetTop: 100, width: 200, height: 300, scale: 2 }
  vi.stubGlobal('window', { innerWidth: 600, innerHeight: 800, visualViewport: viewport })
  expect(canvasNotificationNodeVisible(message)).toBe(false)
  expect(hit).not.toHaveBeenCalled()
  bounds.top = 350; bounds.bottom = 450
  expect(canvasNotificationNodeVisible(message)).toBe(true)
  for (const [x, y] of hit.mock.calls as unknown as Array<[number, number]>) {
    expect(x).toBeGreaterThanOrEqual(80); expect(x).toBeLessThan(280)
    expect(y).toBeGreaterThanOrEqual(350); expect(y).toBeLessThan(400)
  }
  bounds.top = 400; bounds.bottom = 500
  expect(canvasNotificationNodeVisible(message)).toBe(false)
  vi.stubGlobal('window', { innerWidth: 600, innerHeight: 800 })
  expect(canvasNotificationNodeVisible(message)).toBe(true)
})

it('rechecks visual viewport and window changes, then releases exact observer/listener ownership', () => {
  const visualViewport = new EventTarget(), window = Object.assign(new EventTarget(), { visualViewport })
  const mutationDisconnect = vi.fn(), resizeDisconnect = vi.fn(), schedule = vi.fn()
  vi.stubGlobal('window', window); vi.stubGlobal('document', { body: {} })
  vi.stubGlobal('MutationObserver', class { observe() {} disconnect = mutationDisconnect })
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect = resizeDisconnect })
  const release = observeCanvasNotificationVisibility(frameFixture('a').frame, schedule)
  for (const target of [window, visualViewport]) for (const event of ['resize', 'scroll']) target.dispatchEvent(new Event(event))
  window.dispatchEvent(new Event('blur'))
  expect(schedule).toHaveBeenCalledTimes(5)
  release()
  expect(mutationDisconnect).toHaveBeenCalledOnce(); expect(resizeDisconnect).toHaveBeenCalledOnce()
  for (const target of [window, visualViewport]) for (const event of ['resize', 'scroll']) target.dispatchEvent(new Event(event))
  window.dispatchEvent(new Event('blur'))
  expect(schedule).toHaveBeenCalledTimes(5)
})

it('indexes mounted frames once for a multi-card dispatch and never acknowledges covered rows', () => {
  const rows = Array.from({ length: 64 }, (_, index) => frameFixture('card-' + index, index * 20))
  const query = vi.fn(() => rows.map(row => row.frame)), store = new CanvasNotificationVisibility()
  for (const row of rows) store.register(row.frame.dataset.canvasConversationKey!, 'thread').publish('public', source('thread', row.message.getAttribute('data-message-id')!))
  vi.stubGlobal('getComputedStyle', visibleStyle)
  vi.stubGlobal('window', { innerWidth: 600, innerHeight: 2000, visualViewport: { offsetLeft: 0, offsetTop: 0, width: 600, height: 640 } })
  vi.stubGlobal('document', { visibilityState: 'visible', hasFocus: () => true, querySelectorAll: query,
    elementFromPoint: (_x: number, y: number) => rows.find(row => y >= row.bounds.top && y < row.bounds.bottom)?.message ?? null })
  const reports = store.readVisibleSources()
  expect(query).toHaveBeenCalledOnce()
  expect(reports).toHaveLength(64)
  expect(reports.filter(row => row.surfaceVisible).flatMap(row => row.messageIds)).toEqual(rows.slice(0, 32).map(row => row.frame.dataset.canvasConversationKey))
  expect(reports.slice(32).every(row => !row.surfaceVisible && !row.messageIds.length)).toBe(true)
  expect(store.getSnapshot().every(row => row.surfaceVisible && row.messageIds.length === 1)).toBe(true)
})
