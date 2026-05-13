import { BadRequestException, Injectable, MessageEvent } from '@nestjs/common';
import { interval, merge, Observable, Subject } from 'rxjs';
import { endWith, ignoreElements, map, share, takeUntil } from 'rxjs/operators';
import { SseStreamMessage, toMessageEvent } from './sse-events.types';

/** Nest `SseStream`은 SSE comment(`:`) 라인을 쓸 수 없어, 연결 유지용 짧은 JSON ping으로 대체한다. */
const HEARTBEAT_INTERVAL_MS = 25_000;

@Injectable()
export class SseService {
  private readonly subjects = new Map<string, Subject<MessageEvent>>();
  private readonly refCounts = new Map<string, number>();
  private readonly disconnectControllers = new Map<string, AbortController>();

  /**
   * userId 단위 SSE 스트림. 동일 userId의 여러 탭은 같은 Subject를 구독(브로드캐스트).
   * 연결이 모두 끊기면 Subject는 complete 후 제거된다.
   * (Nest `RouterResponseController.sse`가 `request.on('close')`에서 구독을 해제한다.)
   */
  connect(userId: string): Observable<MessageEvent> {
    const id = userId.trim();
    if (!id) {
      throw new BadRequestException('userId is required');
    }

    let subject = this.subjects.get(id);
    if (!subject) {
      subject = new Subject<MessageEvent>();
      this.subjects.set(id, subject);
      this.disconnectControllers.set(id, new AbortController());
    }

    this.refCounts.set(id, (this.refCounts.get(id) ?? 0) + 1);

    const userEvents$ = new Observable<MessageEvent>((observer) => {
      const sub = subject!.subscribe(observer);
      return () => {
        sub.unsubscribe();
        const n = (this.refCounts.get(id) ?? 1) - 1;
        if (n <= 0) {
          this.refCounts.delete(id);
          this.disconnectControllers.get(id)?.abort();
          this.disconnectControllers.delete(id);
          subject!.complete();
          this.subjects.delete(id);
        } else {
          this.refCounts.set(id, n);
        }
      };
    }).pipe(share());

    const heartbeat$ = interval(HEARTBEAT_INTERVAL_MS).pipe(
      map(
        (): MessageEvent => ({
          data: { ping: true, at: Date.now() },
        }),
      ),
      takeUntil(userEvents$.pipe(ignoreElements(), endWith(0))),
    );

    return merge(userEvents$, heartbeat$);
  }

  /** 활성 SSE 연결이 있을 때만 유효한 시그널. `chat` 등과 `mergeAbortSignals`로 합치면 된다. */
  getClientDisconnectSignal(userId: string): AbortSignal | undefined {
    return this.disconnectControllers.get(userId.trim())?.signal;
  }

  /**
   * 활성 SSE 연결이 있는 userId에만 이벤트를 보낸다. 구독자가 없으면 무시한다.
   */
  emitEvent(userId: string, payload: SseStreamMessage): void {
    const id = userId.trim();
    if (!id) {
      return;
    }
    const subject = this.subjects.get(id);
    if (!subject || subject.closed) {
      return;
    }
    subject.next(toMessageEvent(payload));
  }
}
