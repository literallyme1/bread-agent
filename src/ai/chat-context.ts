import { AsyncLocalStorage } from 'async_hooks';
import type { MessageEvent } from '@nestjs/common';

/**
 * 현재 실행 중인 chat() 호출의 컨텍스트.
 * AsyncLocalStorage를 통해 동시 요청 간 격리가 보장됩니다.
 */
export interface ChatContext {
  /** 실제 대화 주체의 userId. 도구 호출 시 이 값이 서버에 전달됩니다. */
  userId: string;
  /**
   * 설정 시 `emit*`은 SseService 대신 이 콜백으로만 전달 (POST /sse 단일 연결).
   */
  streamSink?: (ev: MessageEvent) => void;
}

/**
 * chat() 실행 스코프에서 유효한 컨텍스트 저장소.
 * OpenApiToolset의 execute 핸들러에서 읽어 X-Chat-User-Id 헤더에 주입합니다.
 */
export const chatContextStorage = new AsyncLocalStorage<ChatContext>();
