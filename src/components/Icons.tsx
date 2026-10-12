import type { SVGProps } from 'react'

/**
 * 统一图标集（内联 SVG）。
 *
 * 为什么自己做而不是引图标库：腾讯会议的资源目录里每个图标都有**浅色/深色两套**
 * 且是 normal/hover/click/disable 四态齐全的模板图（Template Mode: automatic，
 * 也就是跟随 tintColor 着色）。内联 SVG + currentColor 天然满足这个约定，
 * 既不增加依赖，也不会像位图那样在深色背景上"变色失败"。
 */
const base = {
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.7,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
} as const

type IconProps = SVGProps<SVGSVGElement> & { size?: number }

function Svg({ size = 20, children, ...rest }: IconProps & { children: React.ReactNode }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" {...base} {...rest}>
      {children}
    </svg>
  )
}

export const IconMic = ({ muted, ...p }: IconProps & { muted?: boolean }) => (
  <Svg {...p}>
    {muted ? (
      <path d="M9 5a3 3 0 0 1 6 0v5M9 11a3 3 0 0 0 5.1 2.1M5 11a7 7 0 0 0 10.6 6M12 18v3M4 4l16 16" />
    ) : (
      <>
        <rect x="9" y="3" width="6" height="11" rx="3" />
        <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
      </>
    )}
  </Svg>
)

export const IconCam = ({ muted, ...p }: IconProps & { muted?: boolean }) => (
  <Svg {...p}>
    {muted ? (
      <path d="M15 10l6-3v10l-3-1.5M3 6h9a3 3 0 0 1 3 3v1M3 6v12h9M4 4l16 16" />
    ) : (
      <>
        <rect x="3" y="6" width="12" height="12" rx="2" />
        <path d="M15 10l6-3v10l-6-3z" />
      </>
    )}
  </Svg>
)

export const IconScreenShare = (p: IconProps) => (
  <Svg {...p}>
    <rect x="3" y="4" width="18" height="12" rx="2" />
    <path d="M8 20h8M12 16v4M12 13V8M9.5 10.5L12 8l2.5 2.5" />
  </Svg>
)

export const IconMembers = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="9" cy="8" r="3.2" />
    <path d="M3.5 20a5.5 5.5 0 0 1 11 0M16 11a3 3 0 1 0 0-6M17 20a5.4 5.4 0 0 0-1.6-3.8" />
  </Svg>
)

export const IconChat = (p: IconProps) => (
  <Svg {...p}>
    <path d="M21 12a8 8 0 0 1-8 8H7l-4 3v-7a8 8 0 0 1 8-8h2a8 8 0 0 1 8 4z" />
  </Svg>
)

export const IconHand = ({ raised, ...p }: IconProps & { raised?: boolean }) => (
  <Svg {...p}>
    <path d="M8 13V5.5a1.5 1.5 0 0 1 3 0V12" />
    <path d="M11 12V4.5a1.5 1.5 0 0 1 3 0V12" />
    <path d="M14 12V6.5a1.5 1.5 0 0 1 3 0V15a6 6 0 0 1-6 6h-1a6 6 0 0 1-6-6v-2l-1.2-2.4a1.5 1.5 0 0 1 2.5-1.6L8 12" />
  </Svg>
)

export const IconSmile = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="M8.5 14.5a4.5 4.5 0 0 0 7 0M9 9.5h.01M15 9.5h.01" />
  </Svg>
)

export const IconMore = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="5.5" cy="12" r="1.4" />
    <circle cx="12" cy="12" r="1.4" />
    <circle cx="18.5" cy="12" r="1.4" />
  </Svg>
)

export const IconLeave = (p: IconProps) => (
  <Svg {...p}>
    <path d="M15 12H4m0 0l3-3m-3 3l3 3M10 4h7a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-7" />
  </Svg>
)

export const IconCopy = (p: IconProps) => (
  <Svg {...p}>
    <rect x="9" y="9" width="11" height="11" rx="2" />
    <path d="M5 15V6a2 2 0 0 1 2-2h9" />
  </Svg>
)

export const IconGrid = (p: IconProps) => (
  <Svg {...p}>
    <rect x="3" y="3" width="8" height="8" rx="1.5" />
    <rect x="13" y="3" width="8" height="8" rx="1.5" />
    <rect x="3" y="13" width="8" height="8" rx="1.5" />
    <rect x="13" y="13" width="8" height="8" rx="1.5" />
  </Svg>
)

export const IconSidebar = (p: IconProps) => (
  <Svg {...p}>
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <path d="M9 4v16M5.5 8h1.5M5.5 12h1.5M5.5 16h1.5" />
  </Svg>
)

export const IconFullscreen = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 9V5h4M20 15v4h-4M20 9V5h-4M4 15v4h4" />
  </Svg>
)

export const IconSettings = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-2.87 1.2V21a2 2 0 1 1-4 0v-.1A1.7 1.7 0 0 0 7 19.4a1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.7 1.7 0 0 0 3 15H3a2 2 0 1 1 0-4h.1A1.7 1.7 0 0 0 4.6 7a1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.7 1.7 0 0 0 9 3V3a2 2 0 1 1 4 0v.1A1.7 1.7 0 0 0 15 4.6a1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.7 1.7 0 0 0 21 9h0a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1.5z" />
  </Svg>
)

export const IconCalendar = (p: IconProps) => (
  <Svg {...p}>
    <rect x="3" y="5" width="18" height="16" rx="2" />
    <path d="M3 10h18M8 3v4M16 3v4" />
  </Svg>
)

export const IconPlus = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 5v14M5 12h14" />
  </Svg>
)

export const IconVideo = (p: IconProps) => (
  <Svg {...p}>
    <rect x="2.5" y="5" width="19" height="14" rx="2.5" />
    <path d="M10 9.5l4.5 2.5-4.5 2.5z" />
  </Svg>
)

export const IconStats = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 19V5M4 19h16M8 16v-5M13 16V8M18 16v-3" />
  </Svg>
)

export const IconShield = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 3l7 3v6c0 4.4-3 7.6-7 9-4-1.4-7-4.6-7-9V6z" />
    <path d="M9.5 12l1.8 1.8L15 10" />
  </Svg>
)

export const IconLink = (p: IconProps) => (
  <Svg {...p}>
    <path d="M10 13a5 5 0 0 0 7.5.5l2-2a5 5 0 0 0-7-7l-1 1" />
    <path d="M14 11a5 5 0 0 0-7.5-.5l-2 2a5 5 0 0 0 7 7l1-1" />
  </Svg>
)

export const IconQr = (p: IconProps) => (
  <Svg {...p}>
    <rect x="3" y="3" width="7" height="7" rx="1.5" />
    <rect x="14" y="3" width="7" height="7" rx="1.5" />
    <rect x="3" y="14" width="7" height="7" rx="1.5" />
    <path d="M14 14h3v3h-3zM20 14v.01M14 20v.01M20 20v.01M20 17v.01M17 20v.01" />
  </Svg>
)

export const IconCheck = (p: IconProps) => (
  <Svg {...p}>
    <path d="M5 12.5l4.5 4.5L19 7.5" />
  </Svg>
)

export const IconChevron = (p: IconProps) => (
  <Svg {...p}>
    <path d="M6 9l6 6 6-6" />
  </Svg>
)

export const IconClose = (p: IconProps) => (
  <Svg {...p}>
    <path d="M6 6l12 12M18 6L6 18" />
  </Svg>
)

export const IconContacts = (p: IconProps) => (
  <Svg {...p}>
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <circle cx="9.5" cy="10" r="2.4" />
    <path d="M5.8 16.5a4 4 0 0 1 7.4 0M15 9.5h4M15 13.5h4" />
  </Svg>
)

export const IconDoc = (p: IconProps) => (
  <Svg {...p}>
    <path d="M6 3h8l4 4v14H6z" />
    <path d="M14 3v4h4M9 12h6M9 16h6" />
  </Svg>
)
