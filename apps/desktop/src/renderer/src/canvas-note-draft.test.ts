import { describe, expect, it } from 'vitest'
import { loadCanvasNoteDraft, saveCanvasNoteDraft, type CanvasNoteDraft, type CanvasNoteStorage } from './canvas-note-draft'

const scope = { host: 'https://设备甲', core: 'C:\\测试\\Core甲' }
const draft: CanvasNoteDraft = { text: '未保存的最后一字：乙', baseline: '原文', revision: 17 }
function memory() {
  const values = new Map<string, string>()
  const storage: CanvasNoteStorage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value) }, removeItem: key => { values.delete(key) } }
  return { storage, values }
}

describe('画布便笺本机草稿的恢复和归属', () => {
  it('末次输入及其原文/版本一起恢复，空文字也是一次有效修改', () => {
    const { storage } = memory()
    for (const text of ['新', '新内容\n最终中文字符乙', '']) {
      expect(saveCanvasNoteDraft(storage, scope, '画板', '便笺', { ...draft, text })).toBe(true)
      expect(loadCanvasNoteDraft(storage, scope, '画板', '便笺')).toEqual({ ...draft, text })
    }
  })
  it('Host、Core、画板和便笺各自隔离，不借用其他归属的草稿', () => {
    const { storage } = memory()
    saveCanvasNoteDraft(storage, scope, '板甲', '便笺甲', draft)
    for (const [owner, board, node] of [
      [{ ...scope, host: 'https://设备乙' }, '板甲', '便笺甲'],
      [{ ...scope, core: 'C:\\测试\\Core乙' }, '板甲', '便笺甲'],
      [scope, '板乙', '便笺甲'], [scope, '板甲', '便笺乙']
    ] as const) expect(loadCanvasNoteDraft(storage, owner, board, node)).toBeNull()
    expect(loadCanvasNoteDraft(storage, scope, '板甲', '便笺甲')).toEqual(draft)
  })
  it('复合身份中的引号与分隔符不造成另一张便笺碰撞', () => {
    const { storage } = memory()
    saveCanvasNoteDraft(storage, scope, 'a:b', 'c"d', draft)
    expect(loadCanvasNoteDraft(storage, scope, 'a', 'b:c"d')).toBeNull()
  })
  it('确认保存后只移除本便笺副本，其他便笺和原视口偏好保持', () => {
    const { storage, values } = memory()
    storage.setItem('rovai.canvas.view.v1:old', 'viewport')
    saveCanvasNoteDraft(storage, scope, '板', '甲', draft)
    saveCanvasNoteDraft(storage, scope, '板', '乙', draft)
    expect(saveCanvasNoteDraft(storage, scope, '板', '甲', null)).toBe(true)
    expect(loadCanvasNoteDraft(storage, scope, '板', '甲')).toBeNull()
    expect(loadCanvasNoteDraft(storage, scope, '板', '乙')).toEqual(draft)
    expect(values.get('rovai.canvas.view.v1:old')).toBe('viewport')
  })
  it('禁用或满额的本机存储明确返回失败，不能声称已保存副本', () => {
    const unavailable = () => { throw new Error('denied') }
    const storage = { getItem: unavailable, setItem: unavailable, removeItem: unavailable }
    expect(saveCanvasNoteDraft(undefined, scope, '板', '甲', draft)).toBe(false)
    expect(saveCanvasNoteDraft(storage, scope, '板', '甲', draft)).toBe(false)
    expect(loadCanvasNoteDraft(storage, scope, '板', '甲')).toBeNull()
  })
  it('没有可信所属信息时不读写，不采用旧版无归属草稿', () => {
    const { storage, values } = memory()
    storage.setItem('canvas-note-draft:甲', JSON.stringify(draft))
    for (const owner of [null, { ...scope, core: '' }, { ...scope, host: 'bad\0host' }]) {
      expect(saveCanvasNoteDraft(storage, owner, '板', '甲', draft)).toBe(false)
      expect(loadCanvasNoteDraft(storage, owner, '板', '甲')).toBeNull()
    }
    expect(loadCanvasNoteDraft(storage, scope, '板', '甲')).toBeNull()
    expect(values.size).toBe(1)
  })
  it.each(['{broken', 'null', '[]', '{"text":"x"}', '{"text":"x","baseline":"b","revision":-1}', '{"text":"x","baseline":"b","revision":1.2}'])('损坏的草稿不作为编辑或命令输入：%s', raw => {
    const { storage, values } = memory()
    saveCanvasNoteDraft(storage, scope, '板', '甲', draft)
    values.set([...values.keys()][0], raw)
    expect(loadCanvasNoteDraft(storage, scope, '板', '甲')).toBeNull()
  })
})
