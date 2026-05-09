import { Injectable, Inject, Logger } from '@nestjs/common';
import { Redis } from 'ioredis';
import { REDIS_CLIENT } from './redis.constants';
import {
  CurrentSession,
  Profile,
  RedisUserSession,
  RedisUserSessionSchema,
} from './session.schema';

export interface HoldItem {
  inventoryId: number;
  breadId: number;
  breadName: string;
  requestedQty: number;
  heldQty: number;
}

export interface HoldData {
  userId: number;
  storeId: number;
  pickupTime: string;
  items: HoldItem[];
  expiresAt: string;
}

export const HOLD_TTL_SECONDS = 120;

/** 사용자 세션 TTL: 24시간 */
const SESSION_TTL_SECONDS = 86_400;

@Injectable()
export class RedisHoldService {
  private readonly logger = new Logger(RedisHoldService.name);

  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  // ─── Hold CRUD ─────────────────────────────────────────────────────────────

  async createHold(token: string, data: HoldData): Promise<void> {
    await this.redis.set(
      `hold:${token}`,
      JSON.stringify(data),
      'EX',
      HOLD_TTL_SECONDS,
    );
  }

  async getHold(token: string): Promise<HoldData | null> {
    const raw = await this.redis.get(`hold:${token}`);
    if (!raw) return null;
    return JSON.parse(raw) as HoldData;
  }

  async deleteHold(token: string): Promise<void> {
    await this.redis.del(`hold:${token}`);
  }

  async getTtl(token: string): Promise<number> {
    return this.redis.ttl(`hold:${token}`);
  }

  // ─── Session CRUD (key: session:{userId}) ──────────────────────────────────

  /**
   * 사용자 세션 전체를 조회합니다.
   * Redis에 저장된 JSON을 RedisUserSessionSchema로 파싱하여 타입 안전성을 보장합니다.
   */
  async getSession(userId: string): Promise<RedisUserSession | null> {
    const raw = await this.redis.get(`session:${userId}`);
    if (!raw) return null;

    const result = RedisUserSessionSchema.safeParse(JSON.parse(raw));
    if (!result.success) {
      this.logger.warn(
        `[getSession] userId=${userId} schema validation failed: ${result.error.message}`,
      );
      return null;
    }
    return result.data;
  }

  /**
   * 사용자 세션 전체를 덮어씁니다 (TTL: 24시간).
   * 저장 전 RedisUserSessionSchema.parse()로 런타임 검증을 수행합니다.
   */
  async setSession(userId: string, data: RedisUserSession): Promise<void> {
    const validated = RedisUserSessionSchema.parse(data);
    await this.redis.set(
      `session:${userId}`,
      JSON.stringify(validated),
      'EX',
      SESSION_TTL_SECONDS,
    );
  }

  /**
   * 세션의 profile 필드를 부분 업데이트합니다.
   * 기존 세션이 없으면 신규 생성합니다.
   */
  async updateProfile(userId: string, profile: Partial<Profile>): Promise<void> {
    const existing = (await this.getSession(userId)) ?? {};
    const merged: RedisUserSession = {
      ...existing,
      profile: { ...existing.profile, ...profile } as Profile,
    };
    await this.setSession(userId, merged);
  }

  /**
   * current_session 필드를 부분 업데이트합니다.
   * 기존 current_session 위에 patch를 병합합니다.
   */
  async patchCurrentSession(
    userId: string,
    patch: Partial<CurrentSession>,
  ): Promise<void> {
    const existing = (await this.getSession(userId)) ?? {};
    const merged: RedisUserSession = {
      ...existing,
      current_session: {
        ...existing.current_session,
        ...patch,
      },
    };
    await this.setSession(userId, merged);
  }

  /**
   * current_session만 초기화합니다.
   */
  async clearCurrentSession(userId: string): Promise<void> {
    const existing = await this.getSession(userId);
    if (!existing) return;

    await this.setSession(userId, { ...existing, current_session: undefined });
  }

  /**
   * 사용자 세션 전체를 삭제합니다.
   */
  async deleteSession(userId: string): Promise<void> {
    await this.redis.del(`session:${userId}`);
  }
}
