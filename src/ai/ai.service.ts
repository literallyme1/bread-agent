import { Injectable, Logger, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  InMemoryRunner,
  LlmAgent,
  isFinalResponse,
  stringifyContent,
} from '@google/adk';
import type { Content } from '@google/genai';
import { promises as fsPromises } from 'fs';
import { join } from 'path';
import { OpenApiToolset, OpenApiDocument } from './open-api-toolset';

@Injectable()
export class AiService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(AiService.name);
  private runner: InMemoryRunner | null = null;
  private toolset: OpenApiToolset | null = null;

  constructor(private readonly configService: ConfigService) {}

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
        this.toolset = new OpenApiToolset(swaggerDoc, baseUrl);
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
        model: 'gemini-3.1-flash-lite',
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
   * Send a user message to the agent and receive the final text response.
   * Each call creates an ephemeral session (no cross-call memory).
   * For persistent conversation history, call runSession() instead.
   */
  async chat(userId: string, message: string): Promise<string> {
    if (!this.runner) {
      return 'AI agent is not initialized. Please configure GEMINI_API_KEY or GOOGLE_API_KEY.';
    }

    const userMessage: Content = {
      role: 'user',
      parts: [{ text: message }],
    };

    let finalText = '';
    //runEphemeral : 라이브 스트림 (중간에 계속 상호작용 가능)
    for await (const event of this.runner.runEphemeral({
      userId,
      newMessage: userMessage,
    })) {
      if (isFinalResponse(event)) {
        finalText = stringifyContent(event);
        break;
      }
    }

    return finalText;
  }

  /**
   * Send a user message to the agent within a persistent session.
   * Conversation history is maintained across calls with the same sessionId.
   */
  async runSession(
    userId: string,
    sessionId: string,
    message: string,
  ): Promise<string> {
    if (!this.runner) {
      return 'AI agent is not initialized. Please configure GEMINI_API_KEY or GOOGLE_API_KEY.';
    }

    const userMessage: Content = {
      role: 'user',
      parts: [{ text: message }],
    };

    let finalText = '';
    for await (const event of this.runner.runAsync({
      userId,
      sessionId,
      newMessage: userMessage,
    })) {
      if (isFinalResponse(event)) {
        finalText = stringifyContent(event);
        break;
      }
    }

    return finalText;
  }

  get isReady(): boolean {
    return this.runner !== null;
  }
}
