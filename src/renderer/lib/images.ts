/**
 * 图片附件（A19）：把剪贴板里的截图读成 pi 能吃的 data URL。
 *
 * pi 的 `prompt` 用 `images: [{ type:'image', data, mimeType }]`（RPC）。客户端的约定是
 * **data URL**（`data:image/png;base64,...`）而不是裸 base64 —— 裸 base64 没有 MIME，
 * 主进程只能猜（见 `session-service.ts#toImageContent`）。
 *
 * 这里刻意把「纯规则」和「DOM 读取」分开：
 * - `planAttachments` 是纯函数（单测在 node 里跑，无需浏览器）；
 * - `readClipboardImages` 依赖 ClipboardEvent/FileReader，只有渲染进程能调。
 */

/** 支持的图片类型（pi 侧走各 provider 的视觉接口，gif 只取首帧） */
export const SUPPORTED_IMAGE_MIME = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const

export type SupportedImageMime = (typeof SUPPORTED_IMAGE_MIME)[number]

/** 单张上限 8MB（base64 后会更大，主进程再按 pi 的限制处理） */
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024
/** 单条消息最多 4 张：再多既费 token 也超出多数模型的图片数上限 */
export const MAX_IMAGES_PER_MESSAGE = 4

export interface ImageAttachment {
  /** 仅用于 React key 与 UI 操作 */
  id: string
  dataUrl: string
  mimeType: SupportedImageMime
  bytes: number
  /** 展示用文件名（粘贴时通常是 `image.png`） */
  name: string
}

export interface AttachmentCandidate {
  mimeType: string
  bytes: number
  name: string
}

export interface AttachmentPlan {
  accepted: AttachmentCandidate[]
  rejected: Array<{ candidate: AttachmentCandidate; reason: string }>
}

export function isSupportedImageMime(value: string): value is SupportedImageMime {
  return (SUPPORTED_IMAGE_MIME as readonly string[]).includes(value)
}

/**
 * 纯规则：给定「已有几张」与「新来的候选」，决定收哪些、拒哪些以及原因。
 *
 * 拒绝信息要能直接展示给用户（他们只按了一次 Ctrl+V，不该看到静默失败）。
 */
export function planAttachments(
  existingCount: number,
  candidates: readonly AttachmentCandidate[]
): AttachmentPlan {
  const accepted: AttachmentCandidate[] = []
  const rejected: AttachmentPlan['rejected'] = []

  for (const candidate of candidates) {
    if (!isSupportedImageMime(candidate.mimeType)) {
      rejected.push({
        candidate,
        reason: `不支持的图片类型：${candidate.mimeType || '未知'}（支持 PNG / JPEG / WebP / GIF）`
      })
      continue
    }
    if (candidate.bytes <= 0) {
      rejected.push({ candidate, reason: '图片内容为空' })
      continue
    }
    if (candidate.bytes > MAX_IMAGE_BYTES) {
      rejected.push({
        candidate,
        reason: `图片过大（${formatBytes(candidate.bytes)}），单张上限 ${formatBytes(MAX_IMAGE_BYTES)}`
      })
      continue
    }
    if (existingCount + accepted.length >= MAX_IMAGES_PER_MESSAGE) {
      rejected.push({
        candidate,
        reason: `每条消息最多 ${MAX_IMAGES_PER_MESSAGE} 张图片`
      })
      continue
    }
    accepted.push(candidate)
  }

  return { accepted, rejected }
}

/** data URL 的实际字节数（base64 长度 → 原始字节），用于校验与展示 */
export function dataUrlBytes(dataUrl: string): number {
  const comma = dataUrl.indexOf(',')
  if (comma < 0) return 0
  const payload = dataUrl.slice(comma + 1).replace(/\s+/g, '')
  if (payload.length === 0) return 0
  const padding = payload.endsWith('==') ? 2 : payload.endsWith('=') ? 1 : 0
  return Math.floor((payload.length * 3) / 4) - padding
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/** 从 data URL 头部取 MIME（主进程也会校验一次，这里只是 UI 侧分流） */
export function dataUrlMimeType(dataUrl: string): string {
  const match = /^data:([^;,]+)[;,]/.exec(dataUrl)
  return match?.[1] ?? ''
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => {
      reject(new Error('读取图片失败'))
    }
    reader.onload = () => {
      const result = reader.result
      if (typeof result === 'string') resolve(result)
      else reject(new Error('读取图片失败'))
    }
    reader.readAsDataURL(file)
  })
}

export interface ClipboardImages {
  attachments: ImageAttachment[]
  /** 被拒的原因（逐条可展示） */
  errors: string[]
}

/**
 * 从粘贴事件里取出图片（截图工具通常把位图以 `image/png` 放进剪贴板）。
 *
 * 只处理图片；文本粘贴交还给 textarea 的默认行为（不要 preventDefault）。
 */
export async function readClipboardImages(
  event: ClipboardEvent,
  existingCount: number
): Promise<ClipboardImages> {
  const data = event.clipboardData
  if (data === null) return { attachments: [], errors: [] }

  const files: File[] = []
  for (const item of Array.from(data.items)) {
    if (item.kind !== 'file') continue
    const file = item.getAsFile()
    if (file !== null && file.type.startsWith('image/')) files.push(file)
  }
  if (files.length === 0) return { attachments: [], errors: [] }

  const plan = planAttachments(
    existingCount,
    files.map((file) => ({
      mimeType: file.type,
      bytes: file.size,
      name: file.name || '粘贴的图片'
    }))
  )
  const errors = plan.rejected.map((item) => item.reason)

  const attachments: ImageAttachment[] = []
  for (const [index, candidate] of plan.accepted.entries()) {
    const file = files[index]
    if (file === undefined) continue
    try {
      const dataUrl = await readFileAsDataUrl(file)
      const mimeType = dataUrlMimeType(dataUrl)
      if (!isSupportedImageMime(mimeType)) {
        errors.push(`不支持的图片类型：${mimeType || '未知'}`)
        continue
      }
      attachments.push({
        id: `img-${Date.now()}-${index}-${Math.random().toString(36).slice(2, 8)}`,
        dataUrl,
        mimeType,
        bytes: dataUrlBytes(dataUrl),
        name: candidate.name
      })
    } catch (error) {
      errors.push(error instanceof Error ? error.message : '读取图片失败')
    }
  }

  return { attachments, errors }
}
