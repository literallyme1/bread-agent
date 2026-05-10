import { SessionStatus, SessionStatusType } from '../redis/session.schema';

/**
 * 허용되는 상태 전이 매트릭스.
 *
 * ┌───────────────────────────────────┬───────────────────────────────────────────────┐
 * │ Current                           │ Allowed Next                                  │
 * ├───────────────────────────────────┼───────────────────────────────────────────────┤
 * │ SEARCHING                         │ READY_FOR_SUMMARY                             │
 * │ READY_FOR_SUMMARY                 │ PRE_HOLD_CONFIRM, SEARCHING                   │
 * │ PRE_HOLD_CONFIRM                  │ WAITING_FOR_CONFIRM, FAIL                     │
 * │ WAITING_FOR_CONFIRM               │ COMPLETED, EXPIRED                            │
 * │ COMPLETED                         │ WAITING_FOR_CANCELLING_CONFIRM, SEARCHING     │
 * │ WAITING_FOR_CANCELLING_CONFIRM    │ CANCELLED, SEARCHING                          │
 * │ CANCELLED  (terminal)             │ SEARCHING                                     │
 * │ EXPIRED    (terminal)             │ SEARCHING                                     │
 * │ FAIL       (terminal)             │ SEARCHING                                     │
 * └───────────────────────────────────┴───────────────────────────────────────────────┘
 */
const ALLOWED_TRANSITIONS: Readonly<Record<SessionStatusType, readonly SessionStatusType[]>> = {
  [SessionStatus.SEARCHING]: [SessionStatus.READY_FOR_SUMMARY],

  [SessionStatus.READY_FOR_SUMMARY]: [
    SessionStatus.PRE_HOLD_CONFIRM,
    SessionStatus.SEARCHING,
  ],

  [SessionStatus.PRE_HOLD_CONFIRM]: [
    SessionStatus.WAITING_FOR_CONFIRM,
    SessionStatus.FAIL,
  ],

  [SessionStatus.WAITING_FOR_CONFIRM]: [
    SessionStatus.COMPLETED,
    SessionStatus.EXPIRED,
  ],

  [SessionStatus.COMPLETED]: [
    SessionStatus.WAITING_FOR_CANCELLING_CONFIRM,
    SessionStatus.SEARCHING,
  ],

  [SessionStatus.WAITING_FOR_CANCELLING_CONFIRM]: [
    SessionStatus.CANCELLED,
    SessionStatus.SEARCHING,
  ],

  // 종결 상태 → 언제든지 SEARCHING으로 재시작 가능
  [SessionStatus.CANCELLED]: [SessionStatus.SEARCHING],
  [SessionStatus.EXPIRED]: [SessionStatus.SEARCHING],
  [SessionStatus.FAIL]: [SessionStatus.SEARCHING],
} as const;

/**
 * 현재 상태(current)에서 다음 상태(next)로의 전이가 허용되는지 검사합니다.
 *
 * @param current 현재 세션 상태
 * @param next    변경하려는 상태
 * @returns 허용 여부
 */
export function isValidTransition(
  current: SessionStatusType,
  next: SessionStatusType,
): boolean {
  return (ALLOWED_TRANSITIONS[current] as readonly SessionStatusType[]).includes(next);
}

/**
 * 허용된 다음 상태 목록을 반환합니다. (에러 메시지 또는 디버깅용)
 */
export function getAllowedNextStatuses(current: SessionStatusType): readonly SessionStatusType[] {
  return ALLOWED_TRANSITIONS[current];
}
