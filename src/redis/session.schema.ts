import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/**
 * Redis 세션 전용 예약 상태 열거형.
 * DB에 저장되는 ReservationStatus(CONFIRMED | CANCELLED)와 분리된 세션 전용 상태값입니다.
 */
export const SessionStatus = {
  /** 예약에 필요한 정보를 수집 중인 초기 탐색 상태 */
  SEARCHING: 'SEARCHING',
  /** 모든 정보가 수집되어 사용자에게 최종 확인을 구하는 상태 */
  PRE_HOLD_CONFIRM: 'PRE_HOLD_CONFIRM',
  /** holdReservation 성공 후, 2분 내에 최종 확정을 기다리는 상태 */
  WAITING_FOR_CONFIRM: 'WAITING_FOR_CONFIRM',
  /** 취소 요청 시 수수료 고지 후 사용자의 최종 동의를 기다리는 상태 */
  WAITING_FOR_CANCELLING_CONFIRM: 'WAITING_FOR_CANCELLING_CONFIRM',
  /** 예약이 성공적으로 확정된 상태 */
  COMPLETED: 'COMPLETED',
  /** 예약 취소가 완료된 상태 */
  CANCELLED: 'CANCELLED',
  /** 재고 부족이나 시스템 오류로 중단된 상태 */
  FAIL: 'FAIL',
  /** Hold 시간(TTL) 만료로 인해 예약을 진행할 수 없는 상태 */
  EXPIRED: 'EXPIRED',
} as const;

export type SessionStatusType = (typeof SessionStatus)[keyof typeof SessionStatus];

/**
 * SessionStatus Zod enum 스키마.
 * runtime validation(parse/safeParse) 및 Swagger enum 노출에 사용됩니다.
 */
export const SessionStatusZodSchema = z
  .enum([
    'SEARCHING',
    'PRE_HOLD_CONFIRM',
    'WAITING_FOR_CONFIRM',
    'WAITING_FOR_CANCELLING_CONFIRM',
    'COMPLETED',
    'CANCELLED',
    'FAIL',
    'EXPIRED',
  ])
  .describe(
    'Redis 세션 예약 상태:\n' +
      '  SEARCHING - 예약 정보를 수집 중인 초기 탐색 상태\n' +
      '  PRE_HOLD_CONFIRM - 모든 정보가 수집되어 사용자에게 최종 확인을 구하는 상태\n' +
      '  WAITING_FOR_CONFIRM - holdReservation 성공 후 2분 내 최종 확정 대기\n' +
      '  WAITING_FOR_CANCELLING_CONFIRM - 취소 요청 후 수수료 고지, 사용자 최종 동의 대기\n' +
      '  COMPLETED - 예약이 성공적으로 확정된 상태\n' +
      '  CANCELLED - 예약 취소가 완료된 상태\n' +
      '  FAIL - 재고 부족 또는 시스템 오류로 중단된 상태\n' +
      '  EXPIRED - Hold TTL 만료로 인해 예약을 진행할 수 없는 상태',
  );

/**
 * 사용자가 선택한 빵/메뉴 항목 스키마.
 * current_session.selected_items 배열의 요소 구조입니다.
 */
export const SelectedItemSchema = z.object({
  id: z.number().int().describe('빵/메뉴 ID'),
  name: z.string().describe('빵/메뉴 이름'),
  count: z.number().int().min(1).describe('수량 (1 이상)'),
});
export type SelectedItem = z.infer<typeof SelectedItemSchema>;

/**
 * 사용자 선호 프로필 스키마.
 * preferred_station은 특정 역명을 강제하지 않아 동적으로 관리됩니다.
 */
export const ProfileSchema = z.object({
  preferred_station: z
    .string()
    .describe(
      '사용자 선호 지역(역명). 특정 역명을 강제하지 않으며 동적으로 관리됩니다. (예: "신중동역", "강남역")',
    ),
  taste_tags: z
    .array(z.string())
    .describe('취향 태그 배열. (예: ["달지않음", "건강빵"])'),
});
export type Profile = z.infer<typeof ProfileSchema>;

/**
 * 예약 진행을 위한 실시간 세션 데이터 스키마.
 * last_store_id / last_store_name은 매장 선택 시점부터 즉시 저장됩니다.
 */
export const CurrentSessionSchema = z.object({
  last_store_id: z
    .number()
    .int()
    .optional()
    .describe('마지막으로 선택한 매장 ID (매장 선택 시점부터 저장)'),
  last_store_name: z
    .string()
    .optional()
    .describe('마지막으로 선택한 매장 이름 (매장 선택 시점부터 저장)'),
  selected_items: z
    .array(SelectedItemSchema)
    .optional()
    .describe('사용자가 선택한 아이템 목록 ({ id, name, count } 배열)'),
  pickup_time: z
    .string()
    .optional()
    .describe('픽업 예정 시각 (ISO 8601, 예: 2026-05-09T20:00:00)'),
  hold_token: z
    .string()
    .optional()
    .describe('서버에서 발급한 임시 점유 토큰 (예: h-8291-abc-xyz)'),
  status: SessionStatusZodSchema.optional().describe('현재 예약 진행 상태'),
});
export type CurrentSession = z.infer<typeof CurrentSessionSchema>;

/**
 * Redis에 저장되는 사용자 세션 전체 구조.
 * Key: session:{userId}
 *
 * @example
 * {
 *   "profile": { "preferred_station": "신중동역", "taste_tags": ["달지않음", "건강빵"] },
 *   "current_session": {
 *     "last_store_id": 12, "last_store_name": "하레하레 강남",
 *     "selected_items": [{ "id": 101, "name": "소금빵", "count": 2 }],
 *     "pickup_time": "2026-05-09T20:00:00",
 *     "hold_token": "h-8291-abc-xyz",
 *     "status": "WAITING_FOR_CONFIRM"
 *   }
 * }
 */
export const RedisUserSessionSchema = z.object({
  profile: ProfileSchema.optional(),
  current_session: CurrentSessionSchema.optional(),
});
export type RedisUserSession = z.infer<typeof RedisUserSessionSchema>;

// ─── Swagger-compatible DTO classes (nestjs-zod createZodDto) ─────────────────

/** 선택 아이템 DTO - Swagger schema 노출용 */
export class SelectedItemDto extends createZodDto(SelectedItemSchema) {}

/** 사용자 선호 프로필 DTO - Swagger schema 노출용 */
export class ProfileDto extends createZodDto(ProfileSchema) {}

/** 예약 진행 세션 DTO - Swagger schema 노출용 */
export class CurrentSessionDto extends createZodDto(CurrentSessionSchema) {}

/** Redis 사용자 세션 전체 DTO - Swagger schema 노출용 */
export class RedisUserSessionDto extends createZodDto(RedisUserSessionSchema) {}
