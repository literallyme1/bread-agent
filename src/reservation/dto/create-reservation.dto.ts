import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

const ReservationItemSchema = z.object({
  breadId: z.number().int().describe('빵 ID'),
  qty: z.number().int().min(1).describe('예약 수량 (1 이상)'),
});

const CreateHoldSchema = z.object({
  userId: z.number().int().describe('예약 사용자 ID'),

  storeId: z.number().int().describe('예약 대상 매장 ID'),

  pickupTime: z
    .string()
    .describe(
      '픽업 예정 시각 (ISO 8601). ' +
        '현재 시각 이후여야 하며 매장 영업시간(open_time ~ close_time) 범위 내여야 합니다.',
    ),

  items: z
    .array(ReservationItemSchema)
    .describe('예약할 빵 목록 (한 매장에서 여러 종류 동시 예약 가능)'),
});

export class ReservationItemDto extends createZodDto(ReservationItemSchema) {}
export class CreateHoldDto extends createZodDto(CreateHoldSchema) {}
