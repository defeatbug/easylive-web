import { useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { IconChevron } from './Icons'
import { usePopover } from '../lib/popover'
import type { DeviceOption } from '../lib/devices'

interface DevicePickerProps {
  icon: ReactNode
  /** 图标区的文字，例如"麦克风" */
  label: string
  title: string
  /** 设备处于开启状态（关闭时图标变红） */
  active: boolean
  devices: DeviceOption[]
  currentId?: string
  onToggle: () => void
  onSelect: (deviceId: string) => void
  /** 关闭状态下禁用下拉（例如摄像头已关，就没必要选设备） */
  disabled?: boolean
  /**
   * pill = 会前页的横向胶囊；tool = 会中底部工具栏的竖版（图标在上、文字在下、
   * 右上角小箭头），与腾讯会议客户端一致。
   */
  variant?: 'pill' | 'tool'
}

/**
 * 「图标 + 文字 + 独立下拉箭头」的设备控件。
 * 拆成两个按钮是有意的：点主体是开关设备，点箭头才是换设备——这样"开会时手忙脚乱想静音"
 * 不会误触设备列表。
 *
 * 颜色全部走 CSS 变量：会前页是浅色、会中是深色，同一个组件必须两套都成立
 * （腾讯会议的资源目录里也是每个图标一份 *_dark 变体）。
 */
export function DevicePicker({
  icon,
  label,
  title,
  active,
  devices,
  currentId,
  onToggle,
  onSelect,
  disabled,
  variant = 'pill',
}: DevicePickerProps) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  // 与工具栏的其它浮层共享互斥：打开设备列表会关掉"更多/表情/特效"
  usePopover(open, setOpen, rootRef)

  const isTool = variant === 'tool'

  return (
    <div ref={rootRef} className={`relative ${isTool ? '' : ''}`}>
      <div className={isTool ? `tm-picker tm-picker-tool ${active ? '' : 'tm-picker-tool-off'}` : 'tm-picker'}>
        {/* type="button" 必须显式写：在 <form> 内默认是 type="submit"，
            会前页把这个选择器放在表单里，点击麦克风/摄像头就会直接提交表单（= 直接入会） */}
        <button
          type="button"
          onClick={onToggle}
          title={title}
          className={`tm-picker-main ${active ? '' : 'tm-picker-main-off'}`}
        >
          <span className="shrink-0">{icon}</span>
          <span className={isTool ? '' : 'hidden sm:inline'}>{label}</span>
        </button>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          disabled={disabled}
          title="选择设备"
          className={isTool ? 'tm-picker-arrow tm-picker-arrow-tool' : 'tm-picker-arrow'}
        >
          <IconChevron size={isTool ? 10 : 14} />
        </button>
      </div>

      {open && (
        <div
          className={`tm-menu absolute z-40 max-h-64 w-64 overflow-y-auto ${
            isTool ? 'bottom-full left-1/2 mb-2 -translate-x-1/2' : 'top-full left-0 mt-2'
          }`}
        >
          {devices.length === 0 && <p className="px-3 py-2 text-xs text-[var(--text-mute)]">没有可用设备</p>}
          {devices.map((d) => (
            <button
              type="button"
              key={d.deviceId}
              onClick={() => {
                onSelect(d.deviceId)
                setOpen(false)
              }}
              className={`tm-menu-item ${d.deviceId === currentId ? 'tm-menu-item-active' : ''}`}
            >
              <span className="truncate">{d.label}</span>
              {d.deviceId === currentId && <span className="ml-auto shrink-0">✓</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
