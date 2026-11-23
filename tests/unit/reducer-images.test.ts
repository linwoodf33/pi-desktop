import { describe, expect, it } from 'vitest'

import {
  extractImages,
  initialChatState,
  reduceRecord,
  reduceRecords,
  type ChatMessage
} from '../../src/renderer/lib/reducer'

/**
 * 消息里的图片（A21）。
 *
 * pi 的会话 JSONL 把图片存成内容块 `{ type:'image', data:'<base64>', mimeType }`；
 * 客户端统一转成 **data URL**（与 `session:prompt` 的 images 约定一致），
 * 这样实时与回放走同一条路径，`<img src>` 直接可用。
 */
const IMAGE_BLOCK = { type: 'image', data: 'AAAA', mimeType: 'image/png' }

/** reducer 的 `JsonRecord` 未导出：这里用同形状的本地别名（`type` 必填） */
type JsonRecordLike = { type: string } & Record<string, unknown>

function userMessageEnd(content: unknown, timestamp = 1): JsonRecordLike {
  return { type: 'message_end', message: { role: 'user', content, timestamp } }
}

describe('extractImages', () => {
  it('把 ImageContent 转成 data URL', () => {
    expect(extractImages([{ type: 'text', text: '看图' }, IMAGE_BLOCK])).toEqual([
      'data:image/png;base64,AAAA'
    ])
  })

  it('已经是 data URL 时原样保留（历史记录可能有这种形态）', () => {
    expect(
      extractImages([
        { type: 'image', data: 'data:image/jpeg;base64,BBBB', mimeType: 'image/jpeg' }
      ])
    ).toEqual(['data:image/jpeg;base64,BBBB'])
  })

  it('缺 data / mimeType 的块被忽略（不产出坏 src）', () => {
    expect(extractImages([{ type: 'image', data: 'AAAA' }])).toEqual([])
    expect(extractImages([{ type: 'image', mimeType: 'image/png' }])).toEqual([])
  })

  it('纯文本 / 非数组内容返回空', () => {
    expect(extractImages('hello')).toEqual([])
    expect(extractImages(undefined)).toEqual([])
    expect(extractImages([{ type: 'text', text: 'x' }])).toEqual([])
  })
})

describe('message_end(user) 带图片', () => {
  it('用户消息的 images 进入 ChatMessage', () => {
    const state = reduceRecord(
      initialChatState,
      userMessageEnd([{ type: 'text', text: '看图' }, IMAGE_BLOCK])
    )
    const user = state.messages.at(-1) as ChatMessage
    expect(user.role).toBe('user')
    expect(user.text).toBe('看图')
    expect(user.images).toEqual(['data:image/png;base64,AAAA'])
  })

  it('不带图片时不产生 images 字段（保持既有消息形状）', () => {
    const state = reduceRecord(initialChatState, userMessageEnd('纯文本'))
    expect((state.messages.at(-1) as ChatMessage).images).toBeUndefined()
  })

  it('助手消息不会带 images（模型不产出图片）', () => {
    const state = reduceRecord(initialChatState, {
      type: 'message_end',
      message: { role: 'assistant', content: [IMAGE_BLOCK], timestamp: 2 }
    })
    expect((state.messages.at(-1) as ChatMessage).images).toBeUndefined()
  })

  it('先去重键计入图片数量：「同一句话配不同截图」不会被当重复吞掉', () => {
    const withoutImage = reduceRecords(initialChatState, [
      userMessageEnd([{ type: 'text', text: '看图' }])
    ])
    // 同一 timestamp + 同一文本，但多了一张图 → 必须是两条不同消息
    const withImage = reduceRecords(withoutImage, [
      userMessageEnd([{ type: 'text', text: '看图' }, IMAGE_BLOCK])
    ])
    const userMessages = withImage.messages.filter((message) => message.role === 'user')
    expect(userMessages).toHaveLength(2)
    expect(userMessages.at(-1)?.images).toEqual(['data:image/png;base64,AAAA'])
  })

  it('完全相同的带图消息重复到达是幂等的', () => {
    const once = reduceRecord(
      initialChatState,
      userMessageEnd([{ type: 'text', text: '看图' }, IMAGE_BLOCK])
    )
    const twice = reduceRecord(once, userMessageEnd([{ type: 'text', text: '看图' }, IMAGE_BLOCK]))
    expect(twice.messages).toHaveLength(once.messages.length)
  })
})
