/**
 * 图片附件（A19/A20）：把剪贴板截图或拖入的图片文件读成 pi 能吃的 data URL，并在必要时压缩。
 *
 * pi 的 `prompt` 用 `images: [{ type:'image', data, mimeType }]`（RPC）。客户端约定用
 * **data URL**（`data:image/png;base64,...`）而不是裸 base64 —— 裸 base64 没有 MIME，
 * 主进程只能猜（见 `session-service.ts#toImageContent`）。
 *
 * 分层：
 * - **纯规则**（`planAttachments` / `planScale` / `dataUrlBytes`…）在 node 里可单测，不碰 DOM；
 * - **DOM 处理**（`readImageFiles` / `readClipboardImages` / `readDroppedImages`）只在渲染进程调用。
 *
 * 压缩策略（A20）：pi 自己会把图片重编码到 2000×2000 / 4.5MiB(base64) / JPEG q80，
 * 但那发生在**主进程把图片塞进会话之后**。客户端先压一次的价值是：IPC 传输更小、
 * 会话 JSONL 更小、首 token 更快。规则保守、可解释：
 * - 长边 ≤ {@link MAX_EDGE} 且原始数据 ≤ {@link COMPRESS_THRESHOLD_BYTES} → **原样发送**（不重编码，保住画质与透明通道）；
 * - 否则按长边等比缩放，再按「有无透明通道」选编码：可能含 alpha 的格式用 PNG，
 *   仍超标时才退化到 JPEG q0.85 → q0.7。
 */

/** 支持的图片类型（pi 侧走各 provider 的视觉接口，gif 只取首帧） */
export const SUPPORTED_IMAGE_MIME = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const

export type SupportedImageMime = (typeof SUPPORTED_IMAGE_MIME)[number]

/** 单张上限 8MB：超过这个量级基本是「原图」而不是截图，先压缩（不直接拒绝） */
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024
/** 单条消息最多 4 张：再多既费 token 也超出多数模型的图片数上限 */
export const MAX_IMAGES_PER_MESSAGE = 4

/** 压缩后的长边上限（与 pi 的默认 `inputLimits.images.resize` 一致） */
export const MAX_EDGE = 2000
/** 超过这个大小才压缩（低于此值原样发送，避免无谓的画质损失） */
export const COMPRESS_THRESHOLD_BYTES = 2 * 1024 * 1024
/** JPEG 退化质量阶梯（只在 PNG 仍超标时使用） */
export const JPEG_QUALITY_STEPS = [0.85, 0.7] as const

export interface ImageAttachment {
  /** 仅用于 React key 与 UI 操作 */
  id: string
  dataUrl: string
  mimeType: SupportedImageMime
  bytes: number
  /** 展示用文件名（粘贴时通常是 `image.png`） */
  name: string
  width?: number
  height?: number
  /** 压缩前的信息（未压缩时不设置） */
  original?: { width: number; height: number; bytes: number; mimeType: string }
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
 * 注意：**超 8MB 不是拒绝，而是标记为需要压缩**（见 `needsCompression`）。
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

/** 是否需要压缩：只看原始数据大小（尺寸信息要解码后才知道，见 `planScale`） */
export function needsCompression(bytes: number): boolean {
  return bytes > COMPRESS_THRESHOLD_BYTES
}

/**
 * 纯规则：等比缩放到长边 ≤ `maxEdge`。已经够小时原样返回（`scaled=false`），
 * 避免「为了压缩而放大」这种反向操作。
 */
export function planScale(
  width: number,
  height: number,
  maxEdge: number = MAX_EDGE
): { width: number; height: number; scaled: boolean } {
  const longest = Math.max(width, height)
  if (longest <= 0 || longest <= maxEdge) return { width, height, scaled: false }
  const ratio = maxEdge / longest
  return {
    width: Math.max(1, Math.round(width * ratio)),
    height: Math.max(1, Math.round(height * ratio)),
    scaled: true
  }
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

function makeId(index: number): string {
  return `img-${Date.now()}-${index}-${Math.random().toString(36).slice(2, 8)}`
}

type Any2dContext = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D

/**
 * 取 2d context。
 *
 * 为什么不直接 `canvas.getContext('2d')`：`canvas` 是
 * `HTMLCanvasElement | OffscreenCanvas` 联合类型，两者的 `getContext` 重载不同，
 * TS 会退化成 any → 触发 `@typescript-eslint/no-unsafe-call`。
 */
function get2dContext(canvas: HTMLCanvasElement | OffscreenCanvas): Any2dContext | null {
  if (canvas instanceof OffscreenCanvas) return canvas.getContext('2d')
  return canvas.getContext('2d')
}

/** 把 canvas 编成 Blob（优先 OffscreenCanvas.convertToBlob） */
async function encodeCanvas(
  canvas: HTMLCanvasElement | OffscreenCanvas,
  mimeType: string,
  quality: number
): Promise<Blob> {
  if (canvas instanceof OffscreenCanvas) {
    return canvas.convertToBlob({ type: mimeType, quality })
  }
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob === null) reject(new Error('图片编码失败'))
        else resolve(blob)
      },
      mimeType,
      quality
    )
  })
}

function blobToDataUrl(blob: Blob): Promise<string> {
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
    reader.readAsDataURL(blob)
  })
}

/** 可能含透明通道的格式：压缩时优先保 PNG（无损），不得已才退 JPEG */
function mayHaveAlpha(mimeType: string): boolean {
  return mimeType === 'image/png' || mimeType === 'image/webp' || mimeType === 'image/gif'
}

/**
 * 解码 → （必要时）等比缩放 + 重新编码，返回 data URL。
 *
 * 为什么要解码：文件大小不能反映尺寸（一张 1900×1900 的 PNG 也可能 >2MB），
 * 长边超限必须靠真实位图判断。
 */
interface NormalizedImage {
  dataUrl: string
  width: number
  height: number
  originalWidth: number
  originalHeight: number
  originalBytes: number
  originalMimeType: string
  compressed: boolean
}

async function normalizeImage(file: File): Promise<NormalizedImage> {
  const bitmap = await createImageBitmap(file)
  const original = {
    originalWidth: bitmap.width,
    originalHeight: bitmap.height,
    originalBytes: file.size,
    originalMimeType: file.type
  }
  try {
    const scale = planScale(bitmap.width, bitmap.height)
    const mustReencode = scale.scaled || needsCompression(file.size)

    if (!mustReencode) {
      // 够小：原样发送，不重编码（保画质与透明通道）
      return {
        dataUrl: await readFileAsDataUrl(file),
        width: bitmap.width,
        height: bitmap.height,
        ...original,
        compressed: false
      }
    }

    const canvas: HTMLCanvasElement | OffscreenCanvas =
      typeof OffscreenCanvas === 'function'
        ? new OffscreenCanvas(scale.width, scale.height)
        : Object.assign(document.createElement('canvas'), {
            width: scale.width,
            height: scale.height
          })
    const context = get2dContext(canvas)
    if (context === null) {
      // 拿不到 2d context 时退回原图：宁可发大图，也不要发不出去
      return {
        dataUrl: await readFileAsDataUrl(file),
        width: bitmap.width,
        height: bitmap.height,
        ...original,
        compressed: false
      }
    }
    context.drawImage(bitmap, 0, 0, scale.width, scale.height)

    // 先按「保透明」的 PNG 试；仍超标时再退 JPEG（截图多为不透明，JPEG 体积小得多）
    const attempts: Array<{ mimeType: string; quality: number }> = [
      { mimeType: mayHaveAlpha(file.type) ? 'image/png' : 'image/jpeg', quality: 1 },
      ...JPEG_QUALITY_STEPS.map((quality) => ({ mimeType: 'image/jpeg', quality }))
    ]

    let best: { dataUrl: string; bytes: number } | undefined
    for (const attempt of attempts) {
      const blob = await encodeCanvas(canvas, attempt.mimeType, attempt.quality)
      const dataUrl = await blobToDataUrl(blob)
      const bytes = dataUrlBytes(dataUrl)
      if (best === undefined || bytes < best.bytes) best = { dataUrl, bytes }
      if (bytes <= COMPRESS_THRESHOLD_BYTES) break
    }

    return {
      dataUrl: best?.dataUrl ?? (await readFileAsDataUrl(file)),
      width: scale.width,
      height: scale.height,
      ...original,
      compressed: true
    }
  } finally {
    bitmap.close()
  }
}

export interface ImageReadResult {
  attachments: ImageAttachment[]
  /** 被拒 / 压缩失败的原因（逐条可展示） */
  errors: string[]
}

/** 统一入口：粘贴与拖拽共用（都先过 `planAttachments` 规则，再逐张读取/压缩） */
export async function readImageFiles(
  files: readonly File[],
  existingCount: number
): Promise<ImageReadResult> {
  if (files.length === 0) return { attachments: [], errors: [] }

  const plan = planAttachments(
    existingCount,
    files.map((file) => ({
      mimeType: file.type,
      bytes: file.size,
      name: file.name || '图片'
    }))
  )
  const errors = plan.rejected.map((item) => item.reason)
  const attachments: ImageAttachment[] = []

  for (const [index, candidate] of plan.accepted.entries()) {
    const file = files[index]
    if (file === undefined) continue
    try {
      const normalized = await normalizeImage(file)
      const mimeType = dataUrlMimeType(normalized.dataUrl)
      if (!isSupportedImageMime(mimeType)) {
        errors.push(`不支持的图片类型：${mimeType || '未知'}`)
        continue
      }
      attachments.push({
        id: makeId(index),
        dataUrl: normalized.dataUrl,
        mimeType,
        bytes: dataUrlBytes(normalized.dataUrl),
        name: candidate.name,
        width: normalized.width,
        height: normalized.height,
        ...(normalized.compressed
          ? {
              original: {
                width: normalized.originalWidth,
                height: normalized.originalHeight,
                bytes: normalized.originalBytes,
                mimeType: normalized.originalMimeType
              }
            }
          : {})
      })
    } catch (error) {
      errors.push(error instanceof Error ? error.message : '读取图片失败')
    }
  }

  return { attachments, errors }
}

/**
 * 从粘贴事件里取出图片（截图工具通常把位图以 `image/png` 放进剪贴板）。
 *
 * 只处理图片；文本粘贴交还给 textarea 的默认行为（调用方不要 preventDefault）。
 */
export async function readClipboardImages(
  event: ClipboardEvent,
  existingCount: number
): Promise<ImageReadResult> {
  const data = event.clipboardData
  if (data === null) return { attachments: [], errors: [] }

  const files: File[] = []
  for (const item of Array.from(data.items)) {
    if (item.kind !== 'file') continue
    const file = item.getAsFile()
    if (file !== null && file.type.startsWith('image/')) files.push(file)
  }
  return readImageFiles(files, existingCount)
}

/** 从拖拽事件里取出图片文件（多选/整个文件夹拖入时只看直接的文件项） */
export async function readDroppedImages(
  data: DataTransfer | null,
  existingCount: number
): Promise<ImageReadResult> {
  if (data === null) return { attachments: [], errors: [] }
  const files = Array.from(data.files).filter((file) => file.type.startsWith('image/'))
  return readImageFiles(files, existingCount)
}

/** dataTransfer 里是否含图片（用于决定是否接受这次拖拽） */
export function hasImagePayload(data: DataTransfer | null): boolean {
  if (data === null) return false
  if (Array.from(data.items).some((item) => item.kind === 'file' && item.type.startsWith('image/')))
    return true
  return Array.from(data.files).some((file) => file.type.startsWith('image/'))
}
