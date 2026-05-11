import { Injectable, Inject, Logger } from '@nestjs/common';
import { Redis } from 'ioredis';
import { REDIS_CLIENT } from './redis.constants';
import {
  CurrentSession,
  Profile,
  RedisUserSession,
  RedisUserSessionSchema,
  SessionStatus,
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
const SESSION_TTL_SECONDS = 300;

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
   *
   * 세션이 존재하지 않아 새로 생성되는 경우 status의 기본값은 SEARCHING입니다.
   * 기존 세션에 status가 이미 존재하면 해당 값이 유지되며, patch에 status가 포함된 경우에만 덮어씁니다.
   */
  async patchCurrentSession(
    userId: string,
    patch: Partial<CurrentSession>,
  ): Promise<void> {
    const existing = (await this.getSession(userId)) ?? {};
    const merged: RedisUserSession = {
      ...existing,
      current_session: {
        status: SessionStatus.SEARCHING,   // 신규 세션 기본값; 아래 스프레드로 덮어쓰임
        ...existing.current_session,
        ...patch,
      },
    };
    await this.setSession(userId, merged);
  }

  /**
   * current_session만 완전 초기화합니다 (profile은 보존).
   */
  async clearCurrentSession(userId: string): Promise<void> {
    const existing = await this.getSession(userId);
    if (!existing) return;

    await this.setSession(userId, { ...existing, current_session: undefined });
  }

  /**
   * 예약 관련 세션 데이터만 초기화하고 status를 SEARCHING으로 되돌립니다.
   *
   * - profile(preferred_station, taste_tags)은 절대 삭제하지 않고 유지합니다.
   * - current_session 내 예약 관련 필드만 초기값으로 덮어씁니다:
   *     last_store_id / last_store_name → undefined
   *     selected_items                 → [] (빈 배열)
   *     pickup_time / hold_token       → undefined
   *     status                         → SEARCHING
   * - 저장 전 RedisUserSessionSchema.safeParse()로 형식 검증을 수행합니다.
   * - 세션이 존재하지 않으면 아무것도 하지 않습니다.
   */
  async resetCurrentSession(userId: string): Promise<void> {
    const existing = await this.getSession(userId);
    if (!existing) return;

    const reset: RedisUserSession = {
      profile: existing.profile,
      current_session: {
        status: SessionStatus.SEARCHING,
        selected_items: [],
      },
    };

    const validated = RedisUserSessionSchema.safeParse(reset);
    if (!validated.success) {
      this.logger.error(
        `[resetCurrentSession] schema validation failed userId=${userId}: ${validated.error.message}`,
      );
      return;
    }

    await this.setSession(userId, validated.data);
  }

  /**
   * 사용자 세션 전체를 삭제합니다.
   */
  async deleteSession(userId: string): Promise<void> {
    await this.redis.del(`session:${userId}`);
  }
}
