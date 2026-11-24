import { useState } from 'react'

import { WorkspacePicker } from '../reference/WorkspacePicker'
import { phaseLabel } from '../../lib/format'
import {
  MAX_IMAGES_PER_MESSAGE,
  formatBytes,
  hasImagePayload,
  readClipboardImages,
  readDroppedImages,
  type ImageAttachment
} from '../../lib/images'
import type { RunPhase } from '../../lib/reducer'

/**
 * Composer：输入框 + 发送 + 停止（§8.1 M3「停止按钮」）。
 *
 * 停止语义（E4）：点击后按钮**立即**置灰并显示「已中止」，
 * 不等待 `session:abort` 的响应（pi 的 abort 会等会话 idle 才回）。
 */
export interface ComposerProps {
  phase: RunPhase
  aborting: boolean
  aborted: boolean
  /** 没有选中任务时不显示输入区（由空态引导「新建任务」） */
  disabled: boolean
  /** `images` 是 data URL 数组（A19：粘贴截图） */
  onSend: (text: string, images: string[]) => void
  onAbort: () => void
  /**
   * A27：会话引用（活跃会话 sessionKey / 历史任务 sessionFile）。
   * 有它才显示「引用」按钮 —— 选择器需要工作区上下文。
   */
  referenceTarget?: { sessionKey?: string; sessionFile?: string }
}

export function Composer({
  phase,
  aborting,
  aborted,
  disabled,
  onSend,
  onAbort,
  referenceTarget
}: ComposerProps) {
  const [input, setInput] = useState('')
  /** 已粘贴、待发送的图片（A19） */
  const [images, setImages] = useState<ImageAttachment[]>([])
  const [pasteError, setPasteError] = useState<string | undefined>(undefined)
  /** 拖拽悬停中（用于高亮投放区）；只在真的含图片时亮起 */
  const [dragging, setDragging] = useState(false)
  /** A27：应用内引用选择器（一个入口同时选文件与文件夹） */
  const [pickerOpen, setPickerOpen] = useState(false)
  // 只有图片、没有文字也应允许发送（截图直接问「这是什么」）
  const canSend = !disabled && !aborting && (input.trim().length > 0 || images.length > 0)
  const canAbort = !disabled && !aborting && phase !== 'idle'

  const submit = (): void => {
    const text = input.trim()
    if (!canSend) return
    if (text.length === 0 && images.length === 0) return
    const payload = images.map((image) => image.dataUrl)
    setInput('')
    setImages([])
    setPasteError(undefined)
    onSend(text, payload)
  }

  /** 把选到的相对路径插进输入框（末尾追加；已有内容时空格分隔） */
  const insertPath = (relative: string | undefined): void => {
    if (relative === undefined) return
    setInput((current) => (current.length === 0 ? relative : `${current} ${relative}`))
  }

  const appendImages = (result: { attachments: ImageAttachment[]; errors: string[] }): void => {
    if (result.attachments.length > 0) {
      setImages((current) => [...current, ...result.attachments])
      setPasteError(undefined)
    }
    if (result.errors.length > 0) setPasteError(result.errors.join('；'))
  }

  /** Ctrl+V：从剪贴板取图片（截图工具通常给 `image/png`）；纯文本粘贴走默认行为 */
  const handlePaste = (event: React.ClipboardEvent<HTMLTextAreaElement>): void => {
    if (disabled) return
    const hasImage = Array.from(event.clipboardData.items).some(
      (item) => item.kind === 'file' && item.type.startsWith('image/')
    )
    if (!hasImage) return
    // 有图片时阻止默认：否则某些平台会把图片当文件名插进 textarea
    event.preventDefault()
    void readClipboardImages(event.nativeEvent, images.length).then(appendImages)
  }

  /** 拖拽：只在含图片文件时接受（拖文本/链接仍交给浏览器默认行为） */
  const handleDragOver = (event: React.DragEvent<HTMLElement>): void => {
    if (disabled || !hasImagePayload(event.dataTransfer)) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'copy'
    if (!dragging) setDragging(true)
  }

  const handleDrop = (event: React.DragEvent<HTMLElement>): void => {
    if (disabled) return
    if (!hasImagePayload(event.dataTransfer)) return
    // Electron 里不拦默认行为会把窗口导航到该文件
    event.preventDefault()
    setDragging(false)
    void readDroppedImages(event.dataTransfer, images.length).then(appendImages)
  }

  return (
    <footer
      className={dragging ? 'composer composer--dragover' : 'composer'}
      onDragOver={handleDragOver}
      onDragLeave={(event) => {
        // 只有离开整个 composer 才取消高亮（子元素间移动会连发 leave）
        if (event.currentTarget.contains(event.relatedTarget as Node | null)) return
        setDragging(false)
      }}
      onDrop={handleDrop}
      data-testid="composer"
    >
      <textarea
        className="composer__input"
        placeholder={
          disabled
            ? '先新建任务（选择工作目录）才能发送消息'
            : `输入消息，Enter 发送，Shift+Enter 换行；可直接粘贴或拖入截图（最多 ${MAX_IMAGES_PER_MESSAGE} 张）`
        }
        rows={3}
        value={input}
        disabled={disabled}
        onChange={(event) => {
          setInput(event.target.value)
        }}
        onPaste={handlePaste}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault()
            submit()
          }
        }}
      />

      {images.length > 0 || pasteError !== undefined ? (
        <div className="composer__attachments" data-testid="composer-attachments">
          {images.map((image) => (
            <figure
              key={image.id}
              className="composer__attachment"
              data-testid="composer-attachment"
            >
              <img src={image.dataUrl} alt={image.name} />
              <figcaption
                title={
                  image.original === undefined
                    ? image.name
                    : `原图 ${image.original.width}×${image.original.height} · ${formatBytes(image.original.bytes)}`
                }
              >
                {image.mimeType.replace('image/', '').toUpperCase()} · {formatBytes(image.bytes)}
                {image.original === undefined ? '' : ' · 已压缩'}
              </figcaption>
              <button
                type="button"
                className="composer__attachment-remove"
                aria-label={`移除 ${image.name}`}
                data-testid="composer-attachment-remove"
                onClick={() => {
                  setImages((current) => current.filter((item) => item.id !== image.id))
                }}
              >
                ×
              </button>
            </figure>
          ))}
          {pasteError === undefined ? null : (
            <span className="composer__paste-error" data-testid="composer-paste-error" role="alert">
              {pasteError}
            </span>
          )}
        </div>
      ) : null}

      {pickerOpen && referenceTarget !== undefined ? (
        <WorkspacePicker
          target={referenceTarget}
          onPick={(relative) => {
            insertPath(relative)
            setPickerOpen(false)
          }}
          onClose={() => {
            setPickerOpen(false)
          }}
        />
      ) : null}

      <div className="composer__actions">
        <span className="composer__state" data-testid="composer-state">
          {/* E4：点击停止就立即提示「已中止」，不依赖 abort 响应到达 */}
          {aborted ? '已中止' : aborting ? '正在中止…' : phaseLabel(phase)}
        </span>
        <button
          type="button"
          className="btn btn--ghost"
          data-testid="pick-file-button"
          disabled={disabled || referenceTarget === undefined}
          title="插入工作区文件或文件夹的相对路径（模型会用自己的 read 工具去读）"
          onClick={() => {
            setPickerOpen(true)
          }}
        >
          引用
        </button>
        <button
          type="button"
          className="btn btn--ghost"
          data-testid="abort-button"
          disabled={!canAbort}
          onClick={onAbort}
        >
          {aborting ? '中止中…' : aborted ? '已中止' : '停止'}
        </button>
        <button
          type="button"
          className="btn btn--primary"
          data-testid="send-button"
          disabled={!canSend}
          onClick={submit}
        >
          发送
        </button>
      </div>
    </footer>
  )
}
