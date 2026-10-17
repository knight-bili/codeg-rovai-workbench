// Key encoding ported from Codeg aff1e6c src/lib/terminal/keybar.ts (Apache-2.0).
import { writeClipboardText } from './clipboard'

export type TerminalKey = 'esc' | 'tab' | 'slash' | 'dash' | 'home' | 'end' | 'pgup' | 'pgdn' | 'up' | 'down' | 'left' | 'right'
export interface TerminalModifiers { ctrl: boolean; alt: boolean }
export const TERMINAL_KEYS: Array<[TerminalKey, string]> = [['esc', 'Esc'], ['tab', 'Tab'], ['slash', '/'], ['dash', '-'],
  ['left', '←'], ['up', '↑'], ['down', '↓'], ['right', '→'], ['home', 'Home'], ['end', 'End'], ['pgup', 'PgUp'], ['pgdn', 'PgDn']]
const plain: Record<TerminalKey, string> = { esc: '\x1b', tab: '\t', slash: '/', dash: '-', home: '\x1b[H', end: '\x1b[F', pgup: '\x1b[5~', pgdn: '\x1b[6~', up: '\x1b[A', down: '\x1b[B', left: '\x1b[D', right: '\x1b[C' }
const cursor: Partial<Record<TerminalKey, string>> = { up: 'A', down: 'B', right: 'C', left: 'D', home: 'H', end: 'F' }
export function terminalKey(key: TerminalKey, modifiers: TerminalModifiers, applicationCursor = false): string {
  const final = cursor[key], parameter = 1 + (modifiers.alt ? 2 : 0) + (modifiers.ctrl ? 4 : 0)
  if (!modifiers.ctrl && !modifiers.alt) return applicationCursor && final ? `\x1bO${final}` : plain[key]
  if (final) return `\x1b[1;${parameter}${final}`
  if (key === 'pgup' || key === 'pgdn') return `\x1b[${key === 'pgup' ? 5 : 6};${parameter}~`
  return modifiers.alt ? `\x1b${plain[key]}` : plain[key]
}
export function terminalModifiedInput(data: string, modifiers: TerminalModifiers): { out: string; consumed: boolean } {
  if (!data || !modifiers.ctrl && !modifiers.alt) return { out: data, consumed: false }
  let out = data
  const first = data.charCodeAt(0)
  if (modifiers.ctrl) {
    const code = first >= 97 && first <= 122 ? first - 96 : first >= 64 && first <= 95 ? first - 64 : first === 32 ? 0 : first === 63 ? 127 : null
    if (code !== null) out = String.fromCharCode(code) + data.slice(1)
  }
  return { out: modifiers.alt ? `\x1b${out}` : out, consumed: true }
}
export async function copyTerminalSelection(terminal: { getSelection(): string; focus(): void }): Promise<boolean> {
  const value = terminal.getSelection()
  if (!value) return false
  const previous = document.activeElement, copied = await writeClipboardText(value)
  if (document.activeElement === document.body && previous !== document.body) terminal.focus()
  return copied
}
