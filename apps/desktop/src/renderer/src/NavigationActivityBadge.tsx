import { uiAttribute } from './interface-language'

export function NavigationActivityBadge({ count, complete }: { count: number | null; complete: boolean }): React.JSX.Element | null {
  if (count === 0 && complete) return null
  const label = complete && count !== null ? uiAttribute('{0} 个对话正在处理', count)
    : count === null ? uiAttribute('活动统计尚未核对') : uiAttribute('上次统计 {0} 个对话正在处理，等待更新', count)
  return <span className="navigation-activity-badge" data-complete={complete || undefined} title={label} aria-label={label}>
    {count === null ? '…' : complete ? count : `~${count}`}
  </span>
}
