/**
 * 多行粘贴折叠（A28）。
 *
 * 为什么做：粘贴一份 200 行的日志/JSON 到输入框时，直接铺开会把输入区撑爆、
 * 光标位置也难找。CLI 的做法是折叠成一行占位符（形如 `[paste #1-200 lines]`），
 * 发送时再展开。这里照做：
 *
 * - **纯函数**（`planPaste` / `expandPastes`）与 React 无关，可在 node 里单测；
 * - 只有「多行且够长」才折叠，短文本粘贴不受影响（保持原生体验）；
 * - 占位符被用户删掉后，发送时**不会再展开**（以输入框里仍存在的占位符为准）。
 */

/** 折叠阈值：行数达到它就折叠 */
export const PASTE_MIN_LINES = 6
/** 或者总长度达到它（单行超长 base64/JSON 同样折叠） */
export const PASTE_MIN_CHARS = 800

export interface PasteBlock {
  /** 占位符文本（会插入输入框） */
  placeholder: string
  /** 原始内容（发送时展开） */
  content: string
  /** 行数（展示用） */
  lines: number
}

export interface PastePlan {
  /** 是否折叠 */
  compacted: boolean
  /** 要插入输入框的文本（折叠时是占位符，否则是原文） */
  insertText: string
  /** 折叠出的块（未折叠时为 undefined） */
  block?: PasteBlock
}

function countLines(text: string): number {
  if (text.length === 0) return 0
  let lines = 1
  for (const char of text) {
    if (char === '\n') lines += 1
  }
  return text.endsWith('\n') ? lines - 1 : lines
}

/**
 * 判断一段粘贴文本要不要折叠。
 *
 * `seq` 从 1 开始，只用于占位符编号（同一会话里多次粘贴可区分）。
 * 占位符格式与用户要求的写法一致：`[paste #<seq>-<lines> lines]`。
 */
export function planPaste(text: string, seq: number): PastePlan {
  const lines = countLines(text)
  const compacted = lines >= PASTE_MIN_LINES || text.length >= PASTE_MIN_CHARS
  if (!compacted) return { compacted: false, insertText: text }

  const placeholder = `[paste #${seq}-${lines} lines]`
  return {
    compacted: true,
    insertText: placeholder,
    block: { placeholder, content: text, lines }
  }
}

/**
 * 发送前展开：把输入框里**仍然存在**的占位符替换回原文。
 *
 * 为什么要检查「仍然存在」：用户可能手动删掉了占位符的一部分，
 * 这时不该把内容偷偷加回去（否则他删了却还在发，属于见鬼行为）。
 */
export function expandPastes(text: string, blocks: readonly PasteBlock[]): string {
  let result = text
  for (const block of blocks) {
    if (!result.includes(block.placeholder)) continue
    result = result.split(block.placeholder).join(block.content)
  }
  return result
}

/** 清理已不存在于输入框的块（避免状态无限增长） */
export function pruneBlocks(text: string, blocks: readonly PasteBlock[]): PasteBlock[] {
  return blocks.filter((block) => text.includes(block.placeholder))
}
