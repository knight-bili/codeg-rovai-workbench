export function isProjectPath(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 8192
    && !value.includes('\0') && (/^\//.test(value) || /^[A-Za-z]:[\\/]/.test(value) || /^\\\\/.test(value))
    && !value.split(/[\\/]/).some(part => part === '.' || part === '..')
}
