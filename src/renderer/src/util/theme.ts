/** 读取 theme.css 里的设计 token（canvas 类组件无法用 Tailwind class，只能取 CSS 变量） */
export function cssVar(name: string, fallback: string): string {
  if (typeof window === 'undefined') return fallback
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  return value || fallback
}
