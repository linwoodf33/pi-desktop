import { StringDecoder } from 'node:string_decoder'

/**
 * JsonlReader（架构文档 §7 约束 1）：自写 UTF-8 流式分帧读取器，**只在 LF 切分**。
 *
 * 为什么不能用 `readline`：Node 的 `readline` 还会在 `U+2028` / `U+2029` 处切分，
 * 而这两个字符在 JSON 字符串内是合法内容（pi 的会话文本里完全可能出现）。
 *
 * 行为约定：
 * - 跨 chunk 边界的半个 JSON 行：补齐后才产出（U1）；
 * - `U+2028` / `U+2029` 不切分（U2）；
 * - CRLF：剥离行尾可选 `\r` 后解析（U3）；
 * - 非法 JSON：不崩溃，回调 `onInvalid` 产出诊断后继续读下一行（U4）；
 * - **契约**：只把 **JSON 对象**当作一条协议记录。合法但不是对象的行（`null` / `42` / `"x"` /
 *   `[1,2]`）一律走 `onInvalid`，不再悄悄当作记录交给 `onRecord`——JSONL 的每条记录
 *   必然是对象，标量行只可能是上游污染，复用本读取器时无需再自己兜底形状；
 * - `flush()`：冲刷剩余缓冲（进程退出时最后一行可能没有 LF）；
 * - 超长行（默认 16MB）：丢弃该行并给出诊断，避免单行把进程拖进 OOM（§7 约束 14 的同类考虑）。
 */
export interface JsonlReaderOptions {
  /** 收到一条合法 JSON **对象**记录（非对象值走 `onInvalid`） */
  onRecord: (record: Record<string, unknown>) => void
  /** 收到无法解析的行（空行不触发） */
  onInvalid?: (line: string, error: Error) => void
  /** 单行字节上限，超出则丢弃该行并报错；默认 16MB */
  maxLineBytes?: number
}

const DEFAULT_MAX_LINE_BYTES = 16 * 1024 * 1024

export class JsonlReader {
  private readonly decoder = new StringDecoder('utf8')
  private readonly onRecord: (record: Record<string, unknown>) => void
  private readonly onInvalid: (line: string, error: Error) => void
  private readonly maxLineBytes: number

  /** 尚未遇到 LF 的“半行” */
  private buffer = ''
  /** 当前累积的字节数（用于超长行保护） */
  private bufferBytes = 0
  /** 当前行已被判定超长，丢弃到下一个 LF */
  private discarding = false

  constructor(options: JsonlReaderOptions) {
    this.onRecord = options.onRecord
    this.onInvalid = options.onInvalid ?? (() => {})
    this.maxLineBytes = options.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES
  }

  /** 喂入一块数据（Buffer 或字符串）。Buffer 走流式 UTF-8 解码，正确处理被切开的码点。 */
  push(chunk: Buffer | string): void {
    const text = typeof chunk === 'string' ? chunk : this.decoder.write(chunk)
    if (text.length === 0) return
    this.consume(text)
  }

  /** 冲刷剩余缓冲：没有以 LF 结尾的最后一行也要处理 */
  flush(): void {
    const tail = this.decoder.end() + this.buffer
    this.buffer = ''
    this.bufferBytes = 0
    if (this.discarding) {
      // 超长行的残余在 EOF 处直接丢弃
      this.discarding = false
      if (tail.length > 0) {
        this.onInvalid(tail, new Error(`单行超过 ${this.maxLineBytes} 字节，已丢弃`))
      }
      return
    }
    if (tail.length > 0) this.emitLine(tail)
  }

  private consume(text: string): void {
    let start = 0
    while (start <= text.length) {
      const lf = text.indexOf('\n', start)
      if (lf === -1) {
        this.appendRemainder(text.slice(start))
        return
      }
      const segment = text.slice(start, lf)
      if (this.discarding) {
        // 超长行的结尾：丢弃整行
        this.discarding = false
        this.buffer = ''
        this.bufferBytes = 0
        this.onInvalid(segment, new Error(`单行超过 ${this.maxLineBytes} 字节，已丢弃`))
      } else {
        const line = this.buffer + segment
        const lineBytes = this.bufferBytes + Buffer.byteLength(segment, 'utf8')
        this.buffer = ''
        this.bufferBytes = 0
        if (lineBytes > this.maxLineBytes) {
          this.onInvalid(line, new Error(`单行超过 ${this.maxLineBytes} 字节，已丢弃`))
        } else {
          this.emitLine(line)
        }
      }
      start = lf + 1
    }
  }

  private appendRemainder(segment: string): void {
    if (this.discarding) return
    this.buffer += segment
    this.bufferBytes += Buffer.byteLength(segment, 'utf8')
    if (this.bufferBytes > this.maxLineBytes) {
      // 已经超限：丢掉已缓冲内容，后续到 LF 前的字节全部忽略
      this.discarding = true
      this.buffer = ''
      this.bufferBytes = 0
    }
  }

  private emitLine(rawLine: string): void {
    // 只剥离行尾一个可选 CR（CRLF 输入）；行内 CR 属于内容
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine
    if (line.trim().length === 0) return
    let value: unknown
    try {
      value = JSON.parse(line)
    } catch (error) {
      this.onInvalid(line, error instanceof Error ? error : new Error(String(error)))
      return
    }
    // 协议记录必然是 JSON 对象；标量/数组视为非法行（见文件头的契约说明）
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      this.onInvalid(line, new Error('JSONL 记录必须是 JSON 对象'))
      return
    }
    this.onRecord(value as Record<string, unknown>)
  }
}
