import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { Reservation } from '../entity/reservation.entity';
import { ReservationItem } from '../entity/reservation-item.entity';

// ─── Query DTO ────────────────────────────────────────────────────────────────

/**
 * GET /v1/reservations 쿼리 파라미터 스키마.
 * userId는 쿼리 스트링에서 숫자로 coerce되며,
 * status는 API 친화적 소문자('confirmed' | 'cancelled')를 사용합니다.
 */
export const ReservationListQuerySchema = z.object({
  userId: z.coerce
    .number()
    .int()
    .positive()
    .describe('조회할 사용자 ID'),

  status: z
    .enum(['confirmed', 'cancelled'])
    .describe(
      '예약 상태 필터:\n' +
        '  confirmed - 예약이 확정된 내역 조회\n' +
        '  cancelled - 취소된 예약 내역 조회',
    ),
});

export class ReservationListQueryDto extends createZodDto(ReservationListQuerySchema) {}

// ─── Response DTOs ─────────────────────────────────────────────────────────────

/**
 * 예약 목록 조회 응답 - 아이템 단건 스키마
 */
export const ReservationListItemSchema = z.object({
  id: z.number().int().describe('예약 아이템 ID'),
  inventoryId: z.number().int().describe('재고(inventory) ID'),
  qty: z.number().int().describe('예약 수량'),
});

/**
 * 예약 목록 조회 응답 - 예약 단건 스키마
 */
export const ReservationListEntrySchema = z.object({
  id: z.number().int().describe('예약 ID'),
  userId: z.number().int().describe('사용자 ID'),
  status: z
    .enum(['CONFIRMED', 'CANCELLED'])
    .describe('예약 상태 (CONFIRMED: 확정 | CANCELLED: 취소)'),
  pickupTime: z.string().describe('픽업 예정 시각 (ISO 8601)'),
  createdAt: z.string().describe('예약 생성 시각 (ISO 8601)'),
  items: z.array(ReservationListItemSchema).describe('예약 아이템 목록'),
});

export type ReservationListEntry = z.infer<typeof ReservationListEntrySchema>;

/** Swagger schema 노출용 DTO */
export class ReservationListItemDto extends createZodDto(ReservationListItemSchema) {}
export class ReservationListEntryDto extends createZodDto(ReservationListEntrySchema) {}

// ─── Static factory ───────────────────────────────────────────────────────────

export function toReservationListEntry(
  reservation: Reservation,
): ReservationListEntry {
  return {
    id: Number(reservation.id),
    userId: Number(reservation.userId),
    status: reservation.status,
    pickupTime: reservation.pickupTime.toISOString(),
    createdAt: reservation.createdAt.toISOString(),
    items: (reservation.items ?? []).map((item: ReservationItem) => ({
      id: Number(item.id),
      inventoryId: Number(item.inventoryId),
      qty: item.qty,
    })),
  };
}
