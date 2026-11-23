import { z } from 'zod'

/**
 * 跨通道复用的基础 schema。
 *
 * sessionKey 是客户端会话句柄（不等于 pi 的 sessionId，也不等于 sessionFile），
 * 由 SessionService 生成，M2 定义生成规则；M1 只需形状约束。
 */
export const sessionKeySchema = z.string().min(1).max(128)
