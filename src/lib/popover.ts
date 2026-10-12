import { useCallback, useEffect } from 'react'
import type { RefObject } from 'react'

/**
 * 弹层互斥 + 统一的"点外部/按 Esc 关闭"。
 *
 * 为什么需要：工具栏上每个按钮各自管一个 useState，点开 A 再点开 B 时 A 不会自动关闭，
 * 两个浮层就叠在一起互相覆盖——这是真人实测报过来的 bug。
 * 与其在每个组件里各写一遍"关掉别人"，不如收在一个模块里：谁能开、谁该关，只有一处逻辑。
 *
 * 用法：
 *   const close = usePopover(open, setOpen, rootRef)   // rootRef 要包含按钮与浮层本身
 */
type Closer = () => void

let current: Closer | null = null

/** 认领"当前唯一打开的弹层"；上一任会被立即关闭。 */
export function claimPopover(close: Closer): void {
  if (current && current !== close) current()
  current = close
}

/** 释放认领（关闭时调用，避免把别人的认领顶掉）。 */
export function releasePopover(close: Closer): void {
  if (current === close) current = null
}

/** 仅用于测试/诊断：当前是否有弹层打开。 */
export function hasOpenPopover(): boolean {
  return current !== null
}

export function usePopover(
  open: boolean,
  setOpen: (v: boolean) => void,
  ref: RefObject<HTMLElement | null>,
): Closer {
  const close = useCallback(() => setOpen(false), [setOpen])

  // 打开即认领：这样其它已打开的弹层会立刻关上
  useEffect(() => {
    if (!open) {
      releasePopover(close)
      return
    }
    claimPopover(close)
    return () => releasePopover(close)
  }, [open, close])

  // 点外部 / Esc 关闭
  useEffect(() => {
    if (!open) return
    const onDocClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) close()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close()
    }
    document.addEventListener('mousedown', onDocClick)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDocClick)
      document.removeEventListener('keydown', onKey)
    }
  }, [open, close, ref])

  return close
}
