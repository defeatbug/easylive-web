import { useState } from 'react'
import { useImeGuard } from '../lib/ime'

/**
 * 弹幕 / 互动：左下角**独立**的一组按钮（不属于底部导航条）。
 *
 * 为什么单独一组：导航条是"会中控制"（麦克风/摄像头/共享/成员…），
 * 而表情与互动是**表达**——放在一起会让"关闭摄像头"旁边挨着"发小花"这种误触组合。
 * 位置上贴着左下角、和居中的导航条分开，视觉上也更像腾讯会议那套。
 *
 * 交互（按需求定的）：
 *   · 点表情 → 把该表情**追加到输入框**，接着可以继续编辑或点发送；**不直接发送**；
 *   · 输入框**没有 placeholder**：提示文字会让人误以为必须输入才能发；
 *   · 点互动 → 立刻发一条随机的小花/小动作，对方也能看到（走信令面广播）。
 */
const PICKER_EMOJIS = ['👍', '👏', '❤️', '😂', '🎉', '🤔', '😮', '🙏']
/** 互动动效：每次随机挑一个，"小红花和一些小动作" */
const ACTION_EMOJIS = ['🌹', '🌸', '👏', '🎉', '✨']

export function ReactionDock({
  onSend,
  disabled,
}: {
  /** emoji + 可选文字（有文字就是弹幕）+ kind='action' 表示互动动效 */
  onSend: (emoji: string, text?: string, kind?: 'action') => void
  disabled?: boolean
}) {
  const [pickerOpen, setPickerOpen] = useState(false)
  const [draft, setDraft] = useState('')
  const ime = useImeGuard()

  const send = () => {
    const text = draft.trim()
    // 只发了表情时不带文字：那样它就是普通的表情浮层，而不是一条"只有表情的弹幕"
    onSend(text ? '💬' : '💬', text || undefined)
    setDraft('')
    setPickerOpen(false)
  }

  const sendAction = () => {
    const emoji = ACTION_EMOJIS[Math.floor(Math.random() * ACTION_EMOJIS.length)]
    onSend(emoji, undefined, 'action')
  }

  return (
    <div className="reaction-dock">
      <div className="reaction-dock-row">
        {/* 表情：点开选择器，选中后进入输入框（不直接发送） */}
        <button
          type="button"
          onClick={() => setPickerOpen((v) => !v)}
          className={`reaction-dock-btn ${pickerOpen ? 'is-active' : ''}`}
          title="表情：选中后会填进输入框"
          aria-expanded={pickerOpen}
          disabled={disabled}
        >
          😊
        </button>
        {/* 互动：一点就发一朵随机的小花，不需要输入 */}
        <button
          type="button"
          onClick={sendAction}
          className="reaction-dock-btn"
          title="互动：随机送出一朵小花"
          disabled={disabled}
        >
          💐
        </button>
      </div>

      {pickerOpen && (
        <div className="reaction-dock-panel">
          <div className="reaction-dock-emojis">
            {PICKER_EMOJIS.map((e) => (
              <button
                key={e}
                type="button"
                className="reaction-dock-emoji"
                title={`填入 ${e}`}
                onClick={() => setDraft((d) => d + e)}
              >
                {e}
              </button>
            ))}
          </div>
          <div className="reaction-dock-input-row">
            {/* 按需求：**不放 placeholder**（提示文字会让人以为必须先输入） */}
            <input
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onCompositionStart={ime.onCompositionStart}
              onCompositionEnd={ime.onCompositionEnd}
              onKeyDown={(event) => {
                // 中文输入法回车是"确认候选词"，不能当发送
                if (event.key !== 'Enter' || ime.isImeEnter(event)) return
                if (!draft.trim()) return
                send()
              }}
              maxLength={60}
              aria-label="弹幕内容"
              className="reaction-dock-input"
            />
            <button
              type="button"
              className="reaction-dock-send"
              onClick={send}
              disabled={!draft.trim()}
            >发送</button>
          </div>
        </div>
      )}
    </div>
  )
}
