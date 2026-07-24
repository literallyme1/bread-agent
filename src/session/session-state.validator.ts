import { SessionStatus, SessionStatusType } from '../redis/session.schema';

const SERVER_STATE_TRANSITIONS: Readonly<
  Record<SessionStatusType, readonly SessionStatusType[]>
> = {
  [SessionStatus.SEARCHING]: [SessionStatus.READY_FOR_SUMMARY],

  [SessionStatus.READY_FOR_SUMMARY]: [
    SessionStatus.WAITING_FOR_CONFIRM,
    SessionStatus.SEARCHING,
  ],

  [SessionStatus.WAITING_FOR_CONFIRM]: [
    SessionStatus.COMPLETED,
    SessionStatus.EXPIRED,
    SessionStatus.READY_FOR_SUMMARY,
  ],

  [SessionStatus.COMPLETED]: [
    SessionStatus.WAITING_FOR_CANCELLING_CONFIRM,
    SessionStatus.SEARCHING,
  ],

  [SessionStatus.WAITING_FOR_CANCELLING_CONFIRM]: [
    SessionStatus.CANCELLED,
    SessionStatus.SEARCHING,
  ],

  [SessionStatus.CANCELLED]: [SessionStatus.SEARCHING],
  [SessionStatus.EXPIRED]: [SessionStatus.SEARCHING],
  [SessionStatus.FAIL]: [SessionStatus.SEARCHING],
} as const;

/** 서버 상태 머신에서 현재 상태에서 다음 상태로의 전이를 허용하는지 검증한다. */
export function isServerStateTransitionAllowed(
  current: SessionStatusType,
  next: SessionStatusType,
): boolean {
  return SERVER_STATE_TRANSITIONS[current].includes(next);
}

/** 서버 상태 머신에서 허용하는 다음 상태 목록을 반환한다. */
export function getAllowedServerStateTransitions(
  current: SessionStatusType,
): readonly SessionStatusType[] {
  return SERVER_STATE_TRANSITIONS[current];
}
