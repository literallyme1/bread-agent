import { Injectable, Logger, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
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

@Injectable()
export class AiService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(AiService.name);
  private runner: InMemoryRunner | null = null;
  private toolset: OpenApiToolset | null = null;

  constructor(
    private readonly configService: ConfigService,
    private readonly redisService: RedisHoldService,
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

    // @google/genai (used internally by ADK) reads GOOGLE_API_KEY
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
        // AI가 호출하면 안 되거나 지침에 없는 도구를 명시적으로 제외합니다.
        // - deleteSession : 사용자 세션을 완전 삭제 → 실수 호출 시 치명적
        // - aiChat        : AI가 자기 자신을 재귀 호출하는 순환 위험
        // - findStore     : 단건 매장 조회, 지침에 없음 (getStores로 대체)
        // - findReservation: 단건 예약 조회, 지침에 없음 (listReservations로 대체)
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

  /**
   * Redis에서 사용자 세션을 조회하여 AI에게 주입할 SYSTEM CONTEXT 문자열을 생성합니다.
   *
   * RedisUserSession DTO의 모든 필드를 snake_case 이름 그대로 노출합니다.
   * patchSession 도구의 파라미터명과 완전히 일치하므로 AI가 혼동 없이 필드를 참조·수정할 수 있습니다.
   *
   * 세션이 없으면 기본값(SEARCHING)으로 채워진 컨텍스트를 반환합니다.
   */
  private async buildSessionContext(userId: string): Promise<string> {
    const session = await this.redisService.getSession(userId);

    // KST = UTC+9. Intl.DateTimeFormat으로 한국 로컬 시각을 포맷합니다.
    const nowKst = new Intl.DateTimeFormat('ko-KR', {
      timeZone: 'Asia/Seoul',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    }).format(new Date()).replace(/\. /g, '-').replace('.', '');
    // 예: "2026-05-10 15:02:33 KST"
    const currentTimeKst = `${nowKst} KST`;

    // ── profile 필드 (ProfileSchema) ────────────────────────────────────────
    const preferred_station = session?.profile?.preferred_station ?? null;
    const taste_tags        = session?.profile?.taste_tags        ?? [];

    // ── current_session 필드 (CurrentSessionSchema) ──────────────────────────
    const status         = session?.current_session?.status          ?? 'SEARCHING';
    const last_store_id  = session?.current_session?.last_store_id   ?? null;
    const last_store_name = session?.current_session?.last_store_name ?? null;
    const selected_items = session?.current_session?.selected_items  ?? [];
    const pickup_time    = session?.current_session?.pickup_time      ?? null;
    const hold_token     = session?.current_session?.hold_token       ?? null;
    const last_error     = session?.current_session?.last_error       ?? null;

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

  /**
   * 사용자 메시지에 세션 컨텍스트를 주입하여 최종 메시지를 반환합니다.
   */
  private async buildContextualMessage(userId: string, message: string): Promise<string> {
    const context = await this.buildSessionContext(userId);
    return `${context}\n\n[유저 메시지]\n${message}`;
  }

  /**
   * ADK 이벤트 스트림을 처리하여 최종 응답 텍스트를 반환합니다.
   * - 도구 호출/응답 이벤트는 피드백 루프를 위해 로깅됩니다.
   * - isFinalResponse는 "도구 호출/응답이 이 이벤트에 없음" 수준이라, 빈 텍스트인
   *   최종 이벤트가 먼저 오고 이후에 patchSession 등 추가 라운드가 이어질 수 있습니다.
   *   첫 빈 최종에서 break 하면 스트림을 잘라 reply가 ""가 되므로, 스트림을 끝까지
   *   읽고 마지막 의미 있는(공백 아닌) 최종 텍스트를 사용합니다.
   */
  private async processEventStream(
    stream: AsyncIterable<unknown>,
    userId: string,
  ): Promise<string> {
    let lastFinalText = '';
    let lastNonEmptyFinalText = '';

    for await (const raw of stream) {
      const event = raw as Event;

      // 모든 이벤트 요약 — 스트림 흐름 파악용
      const calls = getFunctionCalls(event);
      const responses = getFunctionResponses(event);
      const isFinal = isFinalResponse(event);
      const text = stringifyContent(event);
      this.logger.debug(
        `[event] userId=${userId} author=${event.author} ` +
        `calls=${calls.map(c => c.name).join(',')||'-'} ` +
        `responses=${responses.map(r => r.name).join(',')||'-'} ` +
        `isFinal=${isFinal} partial=${(event as Event & { partial?: boolean }).partial ?? false} ` +
        `textLen=${text.length}`,
      );

      // 도구 호출 파트 — AI가 어떤 도구를 호출했는지 기록 (피드백 루프 관찰)
      if (calls.length > 0) {
        for (const call of calls) {
          this.logger.log(
            `[tool:call] userId=${userId} tool=${call.name} args=${JSON.stringify(call.args)}`,
          );
        }
      }

      // 도구 응답 파트 — 도구 실행 결과가 AI에게 피드백되었음을 기록
      if (responses.length > 0) {
        for (const resp of responses) {
          this.logger.log(
            `[tool:response] userId=${userId} tool=${resp.name} response=${JSON.stringify(resp.response)}`,
          );
        }
      }

      if (isFinal) {
        lastFinalText = text;
        if (text.trim()) {
          lastNonEmptyFinalText = text;
        }
      }
    }

    return lastNonEmptyFinalText || lastFinalText;
  }

  /**
   * 사용자 메시지를 AI에게 전송하고 최종 응답을 받습니다.
   * - 전송 전 Redis 세션을 조회하여 SYSTEM CONTEXT를 메시지 앞에 주입합니다.
   * - AsyncLocalStorage로 userId를 격리하여 도구 호출 시 userId 위변조를 차단합니다.
   * - 각 호출은 독립적인 ephemeral 세션으로 처리됩니다.
   */
  async chat(userId: string, message: string): Promise<string> {
    if (!this.runner) {
      return 'AI agent is not initialized. Please configure GEMINI_API_KEY or GOOGLE_API_KEY.';
    }

    const contextualMessage = await this.buildContextualMessage(userId, message);

    const userMessage: Content = {
      role: 'user',
      parts: [{ text: contextualMessage }],
    };

    // AsyncLocalStorage에 userId를 저장하고 그 스코프 안에서 ADK runner를 실행.
    // 도구 호출 시 OpenApiToolset이 X-Chat-User-Id 헤더에 이 userId를 자동 주입합니다.
    return chatContextStorage.run({ userId }, async () => {
      const stream = this.runner!.runEphemeral({ userId, newMessage: userMessage });
      return this.processEventStream(stream, userId);
    });
  }

  /**
   * 지속적인 대화 세션에서 사용자 메시지를 처리합니다.
   * 같은 sessionId로 호출하면 이전 대화 이력이 유지됩니다.
   */
  async runSession(
    userId: string,
    sessionId: string,
    message: string,
  ): Promise<string> {
    if (!this.runner) {
      return 'AI agent is not initialized. Please configure GEMINI_API_KEY or GOOGLE_API_KEY.';
    }

    const contextualMessage = await this.buildContextualMessage(userId, message);

    const userMessage: Content = {
      role: 'user',
      parts: [{ text: contextualMessage }],
    };

    return chatContextStorage.run({ userId }, async () => {
      const stream = this.runner!.runAsync({ userId, sessionId, newMessage: userMessage });
      return this.processEventStream(stream, userId);
    });
  }

  get isReady(): boolean {
    return this.runner !== null;
  }
}
