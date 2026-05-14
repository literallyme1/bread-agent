import type { MessageEvent } from '@nestjs/common';

/** Logical SSE event names (maps to Nest `MessageEvent.type` → SSE `event:`). */
export const SSE_EVENT_TYPES = ['status', 'chat', 'notice', 'error', 'done'] as const;
export type SseEventType = (typeof SSE_EVENT_TYPES)[number];

/** 규격화된 `error` 이벤트 `data.data.code` 값. */
export const SseErrorCode = {
  AI_ERROR: 'AI_ERROR',
  AI_TIMEOUT: 'AI_TIMEOUT',
  CLIENT_ABORT: 'CLIENT_ABORT',
} as const;
export type SseErrorCodeType = (typeof SseErrorCode)[keyof typeof SseErrorCode];

/** `status` 이벤트의 `data.data.step` 값. */
export enum StatusStep {
  SEARCHING = 'SEARCHING',
  THINKING = 'THINKING',
  PROCESSING = 'PROCESSING',
  IDLE = 'IDLE',
  TOOL_RUNNING = 'TOOL_RUNNING',
  RESPONDING = 'RESPONDING',
}

/**
 * SSE `data:` JSON 본문 공통 형태.
 * `event`별로 `data` 필드 shape가 달라질 수 있음 (프론트는 `event`로 분기).
 */
export interface SseMessageEnvelope<TData = unknown> {
  data: TData;
  message: string;
}

/**
 * 문서·프론트 기준 한 건의 스트림 메시지 (Nest에서는 `type` + `data`로 전송).
 */
export interface SseStreamMessage<TData = unknown> {
  event: SseEventType;
  data: SseMessageEnvelope<TData>;
}

export interface StatusPayload {
  step: StatusStep;
}

/** `chat`: 모델/어시스턴트 텍스트 스트림 조각. */
export interface ChatPayload {
  text?: string;
}

/** `notice`: 차단 없는 안내·토스트용. */
export interface NoticePayload {
  code?: string;
}

/** `error`: 스트림 단위 오류. */
export interface ErrorPayload {
  code: SseErrorCodeType | string;
}

/** `done`: 스트림 정상 종료 신호. */
export interface DonePayload {
  ok?: boolean;
}

/** `status` 전용 편의 타입. */
export type StatusStreamMessage = SseStreamMessage<StatusPayload>;

export function toMessageEvent<TData>(msg: SseStreamMessage<TData>): MessageEvent {
  return {
    type: msg.event,
    data: msg.data,
  };
}
