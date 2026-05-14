import { Injectable, Logger, MessageEvent, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  InMemoryRunner,
  LlmAgent,
  isFinalResponse,
  getFunctionCalls,
  getFunctionResponses,
  stringifyContent,
} from '@google/adk';
import type { Event } from '@google/adk';
import type { Content } from '@google/genai';
import { promises as fsPromises } from 'fs';
import { join } from 'path';
import { OpenApiToolset, OpenApiDocument } from './open-api-toolset';
import { chatContextStorage } from './chat-context';
import { RedisHoldService } from '../redis/redis.service';
import { SessionStatus } from '../redis/session.schema';
import { SseService } from '../sse/sse.service';
import {
  SseErrorCode,
  SseStreamMessage,
  StatusStep,
  toMessageEvent,
} from '../sse/sse-events.types';

export type AiChatOptions = {
  signal?: AbortSignal;
  /** 설정 시 이벤트는 SseService가 아닌 이 sink로만 전달 (POST /sse 한 연결). */
  streamSink?: (ev: MessageEvent) => void;
};

function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError';
}

function abortError(): Error {
  const e = new Error('Aborted');
  e.name = 'AbortError';
  return e;
}

function isHoldExpiredLastError(lastError: string): boolean {
  return lastError.includes('임시 예약') && lastError.includes('만료');
}

@Injectable()
export class AiService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(AiService.name);
  private runner: InMemoryRunner | null = null;
  private toolset: OpenApiToolset | null = null;

  constructor(
    private readonly configService: ConfigService,
    private readonly redisService: RedisHoldService,
    private readonly sse: SseService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.initialize();
  }

  async onApplicationShutdown(): Promise<void> {
    if (this.toolset) {
      await this.toolset.close();
    }
  }

  private async initialize(): Promise<void> {
    const apiKey =
      this.configService.get<string>('GEMINI_API_KEY') ??
      this.configService.get<string>('GOOGLE_API_KEY');

    if (!apiKey) {
      this.logger.warn(
        'Neither GEMINI_API_KEY nor GOOGLE_API_KEY is configured — AI agent will be unavailable',
      );
      return;
    }

    process.env.GOOGLE_API_KEY = apiKey;

    try {
      const [systemInstruction, swaggerDoc] = await Promise.all([
        this.loadSystemInstruction(),
        this.loadSwaggerDocument(),
      ]);

      const baseUrl = this.configService.get<string>(
        'API_BASE_URL',
        'http://localhost:3000',
      );

      if (swaggerDoc) {
        const excludedTools = new Set([
          'deleteSession',
          'aiChat',
          'findStore',
          'findReservation',
        ]);
        this.toolset = new OpenApiToolset(swaggerDoc, baseUrl, excludedTools);
        this.logger.log(
          `OpenApiToolset created: ${this.toolset.toolCount} tool(s) from swagger-spec.json`,
        );
      } else {
        this.logger.warn(
          'swagger-spec.json not found — agent will run without API tools on this boot. ' +
            'Restart the server after the first boot to load tools.',
        );
      }

      const agent = new LlmAgent({
        name: 'bread_path_agent',
        description: 'Bread-Path 빵 예약 AI 에이전트',
        model: 'gemini-2.5-flash',
        instruction: systemInstruction,
        tools: this.toolset ? [this.toolset] : [],
      });

      this.runner = new InMemoryRunner({
        agent,
        appName: 'bread-path',
      });

      this.logger.log('ADK InMemoryRunner initialized successfully');
    } catch (error) {
      this.logger.error(
        'Failed to initialize ADK agent',
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  private async loadSystemInstruction(): Promise<string> {
    try {
      const filePath = join(__dirname, '..', 'prompts', 'bread-system-instruction.md');
      const content = await fsPromises.readFile(filePath, 'utf-8');
      this.logger.log('System instruction loaded successfully');
      return content;
    } catch (error) {
      this.logger.error(
        'Failed to load system instruction, using default fallback',
        error instanceof Error ? error.message : String(error),
      );
      return 'You are a helpful bread shop assistant for Bread-Path(빵길).';
    }
  }

  private async loadSwaggerDocument(): Promise<OpenApiDocument | null> {
    try {
      const filePath = join(process.cwd(), 'swagger-spec.json');
      const content = await fsPromises.readFile(filePath, 'utf-8');
      return JSON.parse(content) as OpenApiDocument;
    } catch {
      return null;
    }
  }

  private async buildSessionContext(userId: string): Promise<string> {
    const session = await this.redisService.getSession(userId);

    const nowKst = new Intl.DateTimeFormat('ko-KR', {
      timeZone: 'Asia/Seoul',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    })
      .format(new Date())
      .replace(/\. /g, '-')
      .replace('.', '');
    const currentTimeKst = `${nowKst} KST`;

    const preferred_station = session?.profile?.preferred_station ?? null;
    const taste_tags = session?.profile?.taste_tags ?? [];

    const status = session?.current_session?.status ?? 'SEARCHING';
    const last_store_id = session?.current_session?.last_store_id ?? null;
    const last_store_name = session?.current_session?.last_store_name ?? null;
    const selected_items = session?.current_session?.selected_items ?? [];
    const pickup_time = session?.current_session?.pickup_time ?? null;
    const hold_token = session?.current_session?.hold_token ?? null;
    const last_error = session?.current_session?.last_error ?? null;

    const lines = [
      '■ [SYSTEM CONTEXT] ■',
      '아래는 현재 대화 중인 사용자의 실시간 Redis 세션 스냅샷입니다.',
      '서버가 비즈니스 로직(상태 전환, 수량 계산 등)을 직접 처리하므로, 도구 응답의 status를 확인하십시오.',
      '',
      `현재 시각 (KST)      : ${currentTimeKst}`,
      '',
      '# 사용자 식별',
      `userId             : ${userId}`,
      '',
      '# profile (기본 선호도)',
      `preferred_station  : ${preferred_station ?? '(미설정)'}`,
      `taste_tags         : ${taste_tags.length > 0 ? JSON.stringify(taste_tags) : '[]'}`,
      '',
      '# current_session (서버 주도 상태 관리)',
      `status             : ${status}`,
      `last_store_id      : ${last_store_id ?? '(없음)'}`,
      `last_store_name    : ${last_store_name ?? '(없음)'}`,
      `selected_items     : ${JSON.stringify(selected_items)}`,
      `pickup_time        : ${pickup_time ? `${pickup_time} KST` : '(미설정)'}`,
      `hold_token         : ${hold_token ?? '(없음)'}`,
      `last_error         : ${last_error ?? '(없음)'}`,
      '',
      `※ 모든 tool 호출 시 userId는 반드시 '${userId}'로 고정한다.`,
    ];

    return lines.join('\n');
  }

  private async buildContextualMessage(userId: string, message: string): Promise<string> {
    const context = await this.buildSessionContext(userId);
    return `${context}\n\n[유저 메시지]\n${message}`;
  }

  private emitSse(userId: string, payload: SseStreamMessage): void {
    const ev = toMessageEvent(payload);
    const ctx = chatContextStorage.getStore();
    if (ctx?.streamSink) {
      ctx.streamSink(ev);
    } else {
      this.sse.emitEvent(userId, payload);
    }
  }

  private emitStatus(userId: string, step: StatusStep, message: string): void {
    this.emitSse(userId, {
      event: 'status',
      data: { data: { step }, message },
    });
  }

  private emitChatChunk(userId: string, chunk: string): void {
    if (!chunk) {
      return;
    }
    this.emitSse(userId, {
      event: 'chat',
      data: { data: { text: chunk }, message: chunk },
    });
  }

  private emitDone(userId: string): void {
    this.emitSse(userId, {
      event: 'done',
      data: { data: { ok: true }, message: '스트리밍이 종료되었습니다.' },
    });
  }

  private emitError(userId: string, code: string, message: string): void {
    this.emitSse(userId, {
      event: 'error',
      data: { data: { code }, message },
    });
  }

  /**
   * 스트림이 끝까지 소비된 뒤 reply가 빈 경우에만 사용하는 최종 안전망 문구.
   * Redis `current_session.status` / `last_error`와 instruction 섹션 7·10을 맞춘다.
   */
  private async resolveEmptyStreamFallbackMessage(userId: string): Promise<string> {
    const session = await this.redisService.getSession(userId.trim());
    const cs = session?.current_session;
    const status = cs?.status;
    const lastError = typeof cs?.last_error === 'string' ? cs.last_error : '';

    if (status === SessionStatus.READY_FOR_SUMMARY && isHoldExpiredLastError(lastError)) {
      return (
        '재고 점유 시간(2분)이 초과되어 예약이 잠시 해제되었습니다.\n' +
        "다시 한번 정보를 확인하고 '예약 진행'을 말씀해주세요."
      );
    }

    switch (status) {
      case SessionStatus.READY_FOR_SUMMARY:
        return (
          '예약 정보를 저장했어요.\n' +
          '현재 예약 정보가 맞는지 확인해 주세요.\n' +
          '이대로 진행할까요?'
        );
      case SessionStatus.WAITING_FOR_CONFIRM:
        return (
          '재고를 임시 확보했어요.\n' +
          '2분 안에 확정해야 합니다.\n' +
          '이대로 예약 확정할까요?'
        );
      case SessionStatus.WAITING_FOR_CANCELLING_CONFIRM:
        return '취소할 예약을 확인해 주세요.\n어떤 예약을 취소할까요?';
      case SessionStatus.COMPLETED:
        return '예약이 확정됐어요.\n픽업 시간에 맞춰 방문해 주세요.';
      case SessionStatus.FAIL:
        return (
          '처리 중 문제가 발생했어요.\n' +
          '조건을 다시 확인하거나 다른 메뉴/매장을 찾아볼까요?'
        );
      case SessionStatus.EXPIRED:
        return '오랫동안 응답이 없어 세션이 만료되었습니다.\n처음부터 다시 도와드릴까요?';
      case SessionStatus.CANCELLED:
        return '예약 취소가 반영됐어요.\n새로 예약을 진행할까요?';
      case SessionStatus.SEARCHING:
        return (
          '검색 결과를 확인했어요.\n' +
          '추천 가능한 매장/메뉴를 찾았습니다.\n' +
          '어떤 메뉴로 예약할까요?'
        );
      default:
        return '처리를 완료했어요.\n다음 단계를 진행할까요?';
    }
  }

  /**
   * `runEphemeral`과 동일한 세션 생명주기이면서 `abortSignal`을 ADK에 전달한다.
   */
  private async *runEphemeralWithAbort(params: {
    userId: string;
    newMessage: Content;
    abortSignal?: AbortSignal;
  }): AsyncGenerator<Event, void, undefined> {
    const r = this.runner!;
    const session = await r.sessionService.createSession({
      appName: r.appName,
      userId: params.userId,
    });
    const sessionId = session.id;
    try {
      yield* r.runAsync({
        userId: params.userId,
        sessionId,
        newMessage: params.newMessage,
        abortSignal: params.abortSignal,
      });
    } finally {
      await r.sessionService.deleteSession({
        appName: r.appName,
        userId: params.userId,
        sessionId,
      });
    }
  }

  /**
   * ADK 이벤트 스트림을 처리하여 최종 응답 텍스트를 반환하고, 중간 SSE를 발행한다.
   */
  private async processEventStream(
    stream: AsyncIterable<Event>,
    userId: string,
    signal?: AbortSignal,
  ): Promise<string> {
    let lastFinalText = '';
    let lastNonEmptyFinalText = '';
    let emittedProcessing = false;
    let lastPartialModelText = '';
    /** SSE로 실제 전송한 chat 텍스트 누적 — 스트림 완료 후 빈 응답 판단에만 사용 */
    let emittedChatAggregate = '';

    const pushChatChunk = (delta: string) => {
      if (!delta) {
        return;
      }
      emittedChatAggregate += delta;
      this.emitChatChunk(userId, delta);
    };

    for await (const event of stream) {
      if (signal?.aborted) {
        throw abortError();
      }

      const calls = getFunctionCalls(event);
      const responses = getFunctionResponses(event);
      const isFinal = isFinalResponse(event);
      const text = stringifyContent(event);
      const partial = (event as Event & { partial?: boolean }).partial === true;

      this.logger.debug(
        `[event] userId=${userId} author=${event.author} ` +
          `calls=${calls.map((c) => c.name).join(',') || '-'} ` +
          `responses=${responses.map((r) => r.name).join(',') || '-'} ` +
          `isFinal=${isFinal} partial=${partial} ` +
          `textLen=${text.length}`,
      );

      if (calls.length > 0) {
        for (const call of calls) {
          this.logger.log(
            `[tool:call] userId=${userId} tool=${call.name} args=${JSON.stringify(call.args)}`,
          );
        }
        this.emitStatus(
          userId,
          StatusStep.THINKING,
          `AI가 ${calls.map((c) => c.name).join(', ')} 도구를 실행 중입니다.`,
        );
      }

      if (responses.length > 0) {
        for (const resp of responses) {
          this.logger.log(
            `[tool:response] userId=${userId} tool=${resp.name} response=${JSON.stringify(resp.response)}`,
          );
        }
        this.emitStatus(
          userId,
          StatusStep.THINKING,
          '도구 실행 결과를 반영해 응답을 준비하고 있습니다.',
        );
      }

      if (!isFinal && text && partial) {
        if (!emittedProcessing) {
          this.emitStatus(
            userId,
            StatusStep.PROCESSING,
            'AI가 답변을 작성하고 있습니다.',
          );
          emittedProcessing = true;
        }
        const delta = text.startsWith(lastPartialModelText)
          ? text.slice(lastPartialModelText.length)
          : text;
        lastPartialModelText = text;
        pushChatChunk(delta);
      }

      if (isFinal) {
        lastFinalText = text;
        if (text.trim()) {
          lastNonEmptyFinalText = text;
        }
        if (text.trim() && !partial) {
          const delta = text.startsWith(lastPartialModelText)
            ? text.slice(lastPartialModelText.length)
            : text;
          lastPartialModelText = text;
          if (delta) {
            if (!emittedProcessing) {
              this.emitStatus(
                userId,
                StatusStep.PROCESSING,
                'AI가 답변을 작성하고 있습니다.',
              );
              emittedProcessing = true;
            }
            pushChatChunk(delta);
          }
        }
      }
    }

    const streamed = emittedChatAggregate.trim();
    let reply = streamed.length > 0 ? emittedChatAggregate : lastNonEmptyFinalText || lastFinalText;

    if (!reply.trim()) {
      this.logger.warn(
        `[processEventStream] userId=${userId} empty reply after stream — SSE fallback`,
      );
      const fallback = await this.resolveEmptyStreamFallbackMessage(userId);
      this.emitChatChunk(userId, fallback);
      reply = fallback;
    }

    return reply;
  }

  async chat(userId: string, message: string, options?: AiChatOptions): Promise<string> {
    if (!this.runner) {
      return 'AI agent is not initialized. Please configure GEMINI_API_KEY or GOOGLE_API_KEY.';
    }

    const timeoutMs = Number(this.configService.get('AI_CHAT_TIMEOUT_MS') ?? 120_000);
    const timeoutController = new AbortController();
    const timeoutId = setTimeout(() => timeoutController.abort(), timeoutMs);

    const outerSignal = options?.signal;
    const merged = outerSignal
      ? mergeAbortSignals(outerSignal, timeoutController.signal)
      : timeoutController.signal;

    try {
      return await chatContextStorage.run(
        { userId, streamSink: options?.streamSink },
        async () => {
        try {
          this.emitStatus(
            userId,
            StatusStep.SEARCHING,
            '매장·예약 세션 정보를 불러오는 중입니다.',
          );

          const contextualMessage = await this.buildContextualMessage(userId, message);

          this.emitStatus(
            userId,
            StatusStep.THINKING,
            'AI가 예약 가능 여부를 확인하고 있습니다.',
          );

          const userMessage: Content = {
            role: 'user',
            parts: [{ text: contextualMessage }],
          };

          const stream = this.runEphemeralWithAbort({
            userId,
            newMessage: userMessage,
            abortSignal: merged,
          });
          const reply = await this.processEventStream(stream, userId, merged);
          this.emitDone(userId);
          return reply;
        } catch (err) {
          if (isAbortError(err)) {
            if (timeoutController.signal.aborted && !outerSignal?.aborted) {
              this.logger.warn(`[chat] userId=${userId} AI_CHAT_TIMEOUT_MS exceeded`);
              this.emitError(
                userId,
                SseErrorCode.AI_TIMEOUT,
                'AI 응답 생성 시간이 초과되었습니다.',
              );
            } else {
              this.logger.warn(`[chat] userId=${userId} aborted (client disconnect or cancel)`);
              this.emitError(
                userId,
                SseErrorCode.CLIENT_ABORT,
                '연결이 종료되어 작업을 중단했습니다.',
              );
            }
          } else {
            const msg = err instanceof Error ? err.message : String(err);
            this.logger.error(
              `[chat] userId=${userId} ${msg}`,
              err instanceof Error ? err.stack : undefined,
            );
            this.emitError(userId, SseErrorCode.AI_ERROR, 'AI 응답 생성 중 오류가 발생했습니다.');
          }
          throw err;
        }
      });
    } finally {
      clearTimeout(timeoutId);
    }
  }

  async runSession(
    userId: string,
    sessionId: string,
    message: string,
    options?: AiChatOptions,
  ): Promise<string> {
    if (!this.runner) {
      return 'AI agent is not initialized. Please configure GEMINI_API_KEY or GOOGLE_API_KEY.';
    }

    const timeoutMs = Number(this.configService.get('AI_CHAT_TIMEOUT_MS') ?? 120_000);
    const timeoutController = new AbortController();
    const timeoutId = setTimeout(() => timeoutController.abort(), timeoutMs);
    const merged = options?.signal
      ? mergeAbortSignals(options.signal, timeoutController.signal)
      : timeoutController.signal;

    try {
      return await chatContextStorage.run(
        { userId, streamSink: options?.streamSink },
        async () => {
        try {
          this.emitStatus(
            userId,
            StatusStep.SEARCHING,
            '매장·예약 세션 정보를 불러오는 중입니다.',
          );

          const contextualMessage = await this.buildContextualMessage(userId, message);

          this.emitStatus(
            userId,
            StatusStep.THINKING,
            'AI가 예약 가능 여부를 확인하고 있습니다.',
          );

          const userMessage: Content = {
            role: 'user',
            parts: [{ text: contextualMessage }],
          };

          const stream = this.runner!.runAsync({
            userId,
            sessionId,
            newMessage: userMessage,
            abortSignal: merged,
          });
          const reply = await this.processEventStream(stream, userId, merged);
          this.emitDone(userId);
          return reply;
        } catch (err) {
          if (isAbortError(err)) {
            if (timeoutController.signal.aborted && !options?.signal?.aborted) {
              this.logger.warn(`[runSession] userId=${userId} AI_CHAT_TIMEOUT_MS exceeded`);
              this.emitError(
                userId,
                SseErrorCode.AI_TIMEOUT,
                'AI 응답 생성 시간이 초과되었습니다.',
              );
            } else {
              this.logger.warn(`[runSession] userId=${userId} aborted`);
              this.emitError(
                userId,
                SseErrorCode.CLIENT_ABORT,
                '연결이 종료되어 작업을 중단했습니다.',
              );
            }
          } else {
            const msg = err instanceof Error ? err.message : String(err);
            this.logger.error(
              `[runSession] userId=${userId} ${msg}`,
              err instanceof Error ? err.stack : undefined,
            );
            this.emitError(userId, SseErrorCode.AI_ERROR, 'AI 응답 생성 중 오류가 발생했습니다.');
          }
          throw err;
        }
      });
    } finally {
      clearTimeout(timeoutId);
    }
  }

  get isReady(): boolean {
    return this.runner !== null;
  }
}

function mergeAbortSignals(a: AbortSignal, b: AbortSignal): AbortSignal {
  if (a.aborted) {
    return a;
  }
  if (b.aborted) {
    return b;
  }
  const c = new AbortController();
  const forward = () => c.abort();
  a.addEventListener('abort', forward, { once: true });
  b.addEventListener('abort', forward, { once: true });
  return c.signal;
}
