// 클라이언트 → 서버 페이로드 검증 스키마. 서버는 여기 통과하지 못한 메시지를 무시한다.
import { z } from 'zod';
import { AVATAR_PARTS } from './types';

export const choiceSchema = z.enum(['O', 'X']);
export const questionKindSchema = z.enum(['NORMAL', 'REVIVAL']);
export const roundModeSchema = z.enum(['NORMAL', 'REVIVAL']);

export const avatarSchema = z.object({
  body: z.number().int().min(0).max(AVATAR_PARTS.body - 1),
  face: z.number().int().min(0).max(AVATAR_PARTS.face - 1),
  hair: z.number().int().min(0).max(AVATAR_PARTS.hair - 1),
});

/** 한국 휴대폰: 010/011/016/017/018/019 + 7~8자리 */
export const PHONE_DIGITS_RE = /^01[016789]\d{7,8}$/;

export const joinRequestSchema = z.object({
  roomCode: z.string().trim().min(1).max(8).optional(),
  phone: z.string().trim().min(9).max(20),
  name: z.string().trim().min(1).max(12),
  avatar: avatarSchema.optional(),
  consent: z.literal(true),
});
export type JoinRequest = z.infer<typeof joinRequestSchema>;

export const answerChooseSchema = z.object({
  index: z.number().int().min(0),
  choice: choiceSchema,
});

export const timePingSchema = z.object({ clientSent: z.number() });

export const playerIdSchema = z.object({ playerId: z.string().min(1).max(64) });

export const showQuestionSchema = z.object({
  index: z.number().int().min(0).optional(),
  mode: roundModeSchema.optional(),
});

export const startTimerSchema = z.object({
  seconds: z.number().int().min(3).max(300).optional(),
});

export const extendTimerSchema = z.object({
  seconds: z.number().int().min(1).max(120),
});

export const startRevivalSchema = z.object({
  index: z.number().int().min(0).optional(),
  force: z.boolean().optional(),
});

export const updateConfigSchema = z
  .object({
    defaultTimeLimitSec: z.number().int().min(3).max(300),
    maxStrikes: z.number().int().min(1).max(5),
    revivalAfterOrderNo: z.number().int().min(0).max(999),
    liveMovesUntilOrderNo: z.number().int().min(-1).max(999),
    answerGraceMs: z.number().int().min(0).max(3000),
    answerRateLimitMs: z.number().int().min(0).max(3000),
    autoStart: z.boolean(),
    autoStartDelaySec: z.number().int().min(0).max(30),
    finalistThreshold: z.number().int().min(0).max(20),
    chatEnabled: z.boolean(),
  })
  .partial();

export const chatSendSchema = z.object({ text: z.string().min(1).max(200) });
export const chatDeleteSchema = z.object({ id: z.string().min(1).max(64) });

export const IMAGE_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'] as const;
export const IMAGE_MAX_BYTES = 3 * 1024 * 1024;

export const questionInputSchema = z.object({
  id: z.string().min(1).max(64).optional(),
  orderNo: z.number().int().min(0).optional(),
  kind: questionKindSchema.default('NORMAL'),
  text: z.string().trim().min(1).max(200),
  answer: choiceSchema,
  timeLimitSec: z.number().int().min(3).max(300).nullable().default(null),
  imageUrl: z.string().trim().max(500).nullable().default(null),
  explanation: z.string().trim().max(300).nullable().default(null),
});
export type QuestionInput = z.infer<typeof questionInputSchema>;

export const questionsReplaceSchema = z.object({
  questions: z.array(questionInputSchema).max(200),
});

export const questionDeleteSchema = z.object({ id: z.string().min(1).max(64) });

export const hostLoginSchema = z.object({ pin: z.string().min(1).max(64) });

export const resetRoomSchema = z.object({
  confirm: z.literal(true),
  keepQuestions: z.boolean().default(true),
});

export const purgeSchema = z.object({ confirm: z.literal(true) });
