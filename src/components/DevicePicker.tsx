import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { DeviceOption } from '../lib/devices'

interface DevicePickerProps {
  icon: ReactNode
  /** 图标区的文字，例如"麦克风"；LiveKit Meet 的控制栏是图标+文字，不是纯图标 */
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
}

/**
 * 「图标 + 文字 + 独立下拉箭头」的胶囊控件。
 * 拆成两个按钮是有意的：点主体是开关设备，点箭头才是换设备——和 LiveKit Meet 一致，
 * 这样"开会时手忙脚乱想静音"不会误触设备列表。
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
}: DevicePickerProps) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDocClick = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDocClick)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDocClick)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <div ref={rootRef} className="relative">
      <div className="flex items-stretch overflow-hidden rounded-lg bg-white/8">
        <button
          onClick={onToggle}
          title={title}
          className={`flex items-center gap-2 py-2 pl-3 pr-2 text-sm font-medium transition hover:bg-white/10 ${
            active ? 'text-neutral-100' : 'text-red-400'
          }`}
        >
          <span className="shrink-0">{icon}</span>
          <span className="hidden sm:inline">{label}</span>
        </button>
        <button
          onClick={() => setOpen((v) => !v)}
          disabled={disabled}
          title="选择设备"
          className="flex items-center px-2 text-neutral-300 transition hover:bg-white/10 disabled:opacity-40"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M6 9l6 6 6-6" />
          </svg>
        </button>
      </div>

      {open && (
        <div className="absolute bottom-full left-0 z-40 mb-2 max-h-64 w-64 overflow-y-auto rounded-lg border border-white/10 bg-[var(--surface-2)] p-1 shadow-2xl">
          {devices.length === 0 && <p className="px-3 py-2 text-xs text-neutral-400">没有可用设备</p>}
          {devices.map((d) => (
            <button
              key={d.deviceId}
              onClick={() => {
                onSelect(d.deviceId)
                setOpen(false)
              }}
              className={`flex w-full items-center gap-2 truncate rounded-md px-3 py-2 text-left text-xs transition hover:bg-white/10 ${
                d.deviceId === currentId ? 'text-[var(--accent)]' : 'text-neutral-200'
              }`}
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
