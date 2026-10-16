/**
 * 头像工具：首字母回落 + 上传前的客户端缩放。
 *
 * 为什么要在客户端缩：后端只接受 ≤512KB 的 png/jpeg/webp。手机直出的照片动辄 3–8MB，
 * 直接上传必然被拒；而在浏览器里先画到 256×256 再编码，通常只剩十几 KB，
 * 既省一次失败往返，也省服务器带宽。后端的类型/大小校验仍然保留——客户端校验只是体验优化。
 */

/** 与后端 maxAvatarBytes 保持一致，避免两边说法不同。 */
export const AVATAR_MAX_BYTES = 512 * 1024

/** 头像显示尺寸上限：界面里最大也就 96px 左右，256 已经足够清晰（含高清屏）。 */
const MAX_EDGE = 256

/** 原图上限：比目标大得多才需要缩放，但太夸张的原图说明用户选错了文件。 */
const MAX_SOURCE_BYTES = 8 * 1024 * 1024

const ACCEPTED_MIME = ['image/png', 'image/jpeg', 'image/webp']

/** 首字母头像：中文取第一个字，拉丁字母取首字母。空名字回落到 "?"。 */
export function initialsOf(name: string): string {
  const trimmed = name.trim()
  if (!trimmed) return '?'
  return Array.from(trimmed)[0]!.toUpperCase()
}

/** 把用户选的图片缩放并重新编码成适合上传的头像文件。 */
export async function resizeAvatarFile(file: File): Promise<File> {
  if (!ACCEPTED_MIME.includes(file.type)) {
    throw new Error('只支持 PNG / JPEG / WebP 格式的图片。')
  }
  if (file.size > MAX_SOURCE_BYTES) {
    throw new Error('原图请控制在 8MB 以内。')
  }

  let bitmap: ImageBitmap
  try {
    bitmap = await createImageBitmap(file)
  } catch {
    throw new Error('无法解析这张图片，请换一张重试。')
  }

  try {
    const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height))
    const width = Math.max(1, Math.round(bitmap.width * scale))
    const height = Math.max(1, Math.round(bitmap.height * scale))

    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('当前浏览器无法处理图片，请更换浏览器后重试。')
    ctx.drawImage(bitmap, 0, 0, width, height)

    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/webp', 0.9))
    if (!blob) throw new Error('图片处理失败，请重试。')

    // 不支持的浏览器会让 toBlob 回落到 PNG —— 所以扩展名与 MIME 必须跟着 blob.type 走，
    // 否则会出现"声明 webp、实际是 png"，后端的白名单校验会以奇怪的方式失败。
    const type = blob.type || 'image/png'
    const ext = type === 'image/webp' ? 'webp' : type === 'image/jpeg' ? 'jpg' : 'png'
    if (blob.size > AVATAR_MAX_BYTES) {
      throw new Error('处理后的头像仍然超过 512KB，请换一张更简单的图片。')
    }
    return new File([blob], `avatar.${ext}`, { type })
  } finally {
    bitmap.close()
  }
}
