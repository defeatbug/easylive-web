import { useCallback, useRef } from 'react'

/**
 * 输入法（IME）组合状态守卫。
 *
 * 问题：用中文/日文输入法敲拼音后按回车是"确认候选词"，浏览器同样会派发
 * `key === 'Enter'` 的 keydown。如果不加判断就会：
 *   1. 把还没确认的内容当成消息发出去；
 *   2. 确认后的文字又落回输入框（React 受控值与 DOM 短暂不同步）；
 *   3. 再按一次回车，又发一遍。
 *
 * 四种判断都要有，才能覆盖各浏览器：
 *   1. 自己维护的组合状态（onCompositionStart / onCompositionEnd）
 *   2. `nativeEvent.isComposing`（Chrome/Edge 在提交候选词那一次为 true）
 *   3. `keyCode === 229`（老式输入法的"正在组合"信号）
 *   4. 组合结束后极短时间内也忽略（Safari 会先 compositionend 再 keydown）
 */
export function useImeGuard() {
  const composing = useRef(false)
  const endedAt = useRef(0)

  const onCompositionStart = useCallback(() => {
    composing.current = true
  }, [])

  const onCompositionEnd = useCallback(() => {
    composing.current = false
    endedAt.current = Date.now()
  }, [])

  /** 这次回车是否只是"输入法确认候选词" */
  const isImeEnter = useCallback((e: { nativeEvent: KeyboardEvent; keyCode: number }) => {
    return (
      composing.current ||
      e.nativeEvent.isComposing ||
      e.keyCode === 229 ||
      Date.now() - endedAt.current < 120
    )
  }, [])

  return { onCompositionStart, onCompositionEnd, isImeEnter }
}
