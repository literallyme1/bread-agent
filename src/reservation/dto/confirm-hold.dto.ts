import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

const ConfirmHoldSchema = z.object({
  userId: z.number().int().describe('예약 사용자 ID'),

  holdToken: z
    .string()
    .describe('hold 생성 시 발급된 토큰 (TTL 2분)'),
});

export class ConfirmHoldDto extends createZodDto(ConfirmHoldSchema) {}
