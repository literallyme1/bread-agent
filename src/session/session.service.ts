import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { RedisHoldService } from '../redis/redis.service';
import {
  CurrentSession,
  Profile,
  RedisUserSession,
  RedisUserSessionSchema,
  SessionStatus,
  SessionStatusType,
} from '../redis/session.schema';

/**
 * patchSession이 수신하는 통합 패치 페이로드.
 *
 * - profile 필드(preferred_station, taste_tags): 최상위로 전달되며 서비스 내부에서 profile 객체에 병합됩니다.
 * - current_session 필드: 나머지 모든 CurrentSession 필드.
 *
 * AI가 단일 patchSession 호출로 profile과 current_session을 동시에 수정할 수 있습니다.
 */
export type SessionPatchPayload = Partial<CurrentSession> & {
  preferred_station?: Profile['preferred_station'];
  taste_tags?: Profile['taste_tags'];
};

/**
 * syncSearchContext에 전달되는 검색 컨텍스트.
 * StoreQueryDto와 호환되는 구조이며, SessionService가 Store 모듈에 의존하지 않도록 별도 정의합니다.
 */
export interface SearchSyncContext {
  userId: string;
  storeId?: number;
  station?: string;
  preference?: string[];
}
import {
  getAllowedNextStatuses,
  isValidTransition,
} from './session-state.validator';

/**
 * READY_FOR_SUMMARY 상태에서 수정될 경우 SEARCHING으로 롤백해야 하는 정보 수집 필드 목록.
 * 이 필드들이 변경되면 수집된 정보가 달라진 것이므로 요약 승인 흐름을 재시작해야 합니다.
 */
const SUMMARY_INVALIDATING_FIELDS: ReadonlyArray<keyof CurrentSession> = [
  'last_store_id',
  'last_store_name',
  'selected_items',
  'pickup_time',
] as const;

@Injectable()
export class SessionService {
  private readonly logger = new Logger(SessionService.name);

  constructor(private readonly redisService: RedisHoldService) {}

  /**
   * 사용자의 전체 Redis 세션(Profile + CurrentSession)을 조회합니다.
   * 세션이 존재하지 않으면 NotFoundException을 던집니다.
   */
  async getSession(userId: string): Promise<RedisUserSession> {
    const session = await this.redisService.getSession(userId);
    if (!session) {
      throw new NotFoundException(`Session not found for userId: ${userId}`);
    }
    return session;
  }

  /**
   * 세션을 Upsert 방식으로 업데이트합니다.
   *
   * - profile 필드(preferred_station, taste_tags)와 current_session 필드를 단일 호출로 함께 수정할 수 있습니다.
   * - 세션이 없으면 기본 스키마({ status: SEARCHING, selected_items: [] })로 먼저 생성한 뒤 병합합니다.
   *
   * 처리 순서:
   *   1. Upsert: 세션 조회 → 없으면 기본 세션으로 초기화
   *   2. profile 필드(preferred_station, taste_tags) 분리 → profile 객체에 병합
   *   3. 현재 상태가 READY_FOR_SUMMARY이고 정보 수집 필드가 수정되는 경우 status를 SEARCHING으로 자동 롤백
   *   4. status 필드가 포함된 경우에만 상태 전이 규칙 검증 (신규 세션이면 모든 상태 허용)
   *   5. 기존 세션에 병합 후 RedisUserSessionSchema.safeParse()로 최종 검증
   *   6. Redis 저장
   */
  async patchSession(userId: string, payload: SessionPatchPayload): Promise<RedisUserSession> {
    // Upsert: rawExisting이 null이면 신규 세션으로 간주.
    // 신규 세션의 currentStatus는 SEARCHING으로 고정하여 상태 전이 검증이
    // SEARCHING을 출발점으로 올바르게 적용되도록 합니다.
    const rawExisting = await this.redisService.getSession(userId);
    const existing: RedisUserSession = rawExisting ?? {
      current_session: {
        status: SessionStatus.SEARCHING,
        selected_items: [],
      },
    };

    if (!rawExisting) {
      this.logger.log(`[patchSession] userId=${userId} session not found — auto-creating with SEARCHING defaults`);
    }

    // profile 필드와 current_session 필드 분리
    const { preferred_station, taste_tags, ...currentSessionPatch } = payload;

    // profile 병합 (제공된 필드만 덮어씀)
    const updatedProfile: RedisUserSession['profile'] =
      preferred_station !== undefined || taste_tags !== undefined
        ? ({
            ...existing.profile,
            ...(preferred_station !== undefined ? { preferred_station } : {}),
            ...(taste_tags !== undefined        ? { taste_tags }        : {}),
          } as Profile)
        : existing.profile;

    // READY_FOR_SUMMARY 상태에서 정보 수집 필드가 수정되면 status를 SEARCHING으로 롤백.
    // 단, patch에 status가 명시적으로 포함된 경우(= 에이전트가 의도적으로 전이를 지정한 경우)는 롤백하지 않음.
    // 신규 세션(rawExisting === null)은 SEARCHING을 출발점으로 고정합니다.
    const currentStatus =
      rawExisting !== null
        ? rawExisting?.current_session?.status
        : SessionStatus.SEARCHING;
    let patch = currentSessionPatch as Partial<CurrentSession>;
    if (
      currentStatus === SessionStatus.READY_FOR_SUMMARY &&
      patch.status === undefined &&
      SUMMARY_INVALIDATING_FIELDS.some((field) => field in patch)
    ) {
      const invalidatedFields = SUMMARY_INVALIDATING_FIELDS.filter((f) => f in patch);
      patch = { ...patch, status: SessionStatus.SEARCHING };
      this.logger.log(
        `[patchSession] userId=${userId} READY_FOR_SUMMARY → SEARCHING auto-rollback` +
          ` (modified fields: [${invalidatedFields.join(', ')}])`,
      );
    }

    // status 필드가 포함된 경우에만 상태 전이 규칙 검증
    if (patch.status !== undefined) {
      this.validateTransition(currentStatus, patch.status, userId);
    }

    const updated: RedisUserSession = {
      profile: updatedProfile,
      current_session: {
        ...existing.current_session,
        ...patch,
      } as CurrentSession,
    };

    const validated = RedisUserSessionSchema.safeParse(updated);
    if (!validated.success) {
      this.logger.error(
        `[patchSession] schema validation failed userId=${userId}: ${validated.error.message}`,
      );
      throw new BadRequestException('Session data failed schema validation');
    }

    await this.redisService.setSession(userId, validated.data);
    this.logger.log(
      `[patchSession] userId=${userId} patched fields=[${Object.keys(payload).join(', ')}]`,
    );

    return validated.data;
  }

  /**
   * 상태 전이 규칙을 검증합니다.
   * current가 undefined인 경우(기존 세션에 status 필드가 없는 비정상 상태) 모든 상태 설정을 허용합니다.
   * 신규 세션은 호출 전에 currentStatus가 SEARCHING으로 설정되므로 이 분기를 타지 않습니다.
   * 허용되지 않는 전이 시 400 BadRequestException을 던집니다.
   */
  private validateTransition(
    current: SessionStatusType | undefined,
    next: SessionStatusType,
    userId: string,
  ): void {
    if (current === undefined) {
      // status 필드가 없는 기존 세션(비정상 케이스) → 복구 허용
      return;
    }

    if (!isValidTransition(current, next)) {
      const allowed = getAllowedNextStatuses(current).join(', ');
      this.logger.warn(
        `[validateTransition] invalid transition userId=${userId} ${current} → ${next} (allowed: ${allowed})`,
      );
      throw new BadRequestException(
        `현재 ${current}에서 ${next}로의 변경은 허용되지 않습니다. ` +
          `(${current}에서 허용된 다음 상태: ${allowed})`,
      );
    }

    this.logger.log(
      `[validateTransition] valid transition userId=${userId} ${current} → ${next}`,
    );
  }

  /**
   * 예약 관련 세션 데이터를 초기화하고 status를 SEARCHING으로 되돌립니다.
   *
   * profile(preferred_station, taste_tags)은 보존하며,
   * current_session 내 예약 필드(last_store_id, last_store_name, selected_items,
   * pickup_time, hold_token)만 초기값으로 덮어씁니다.
   *
   * COMPLETED 또는 CANCELLED 완료 직후 호출하여 다음 예약을 바로 시작할 수 있도록
   * 세션을 준비 상태로 전환합니다.
   *
   * 세션이 존재하지 않으면 NotFoundException을 던집니다.
   */
  async resetSession(userId: string): Promise<void> {
    const existing = await this.redisService.getSession(userId);
    if (!existing) {
      throw new NotFoundException(`Session not found for userId: ${userId}`);
    }

    await this.redisService.resetCurrentSession(userId);
    this.logger.log(
      `User ${userId}의 세션이 초기화되었습니다. 상태가 SEARCHING으로 리셋됩니다.`,
    );
  }

  /**
   * 사용자의 Redis 세션 전체를 삭제합니다.
   * 세션이 존재하지 않으면 NotFoundException을 던집니다.
   */
  async deleteSession(userId: string): Promise<void> {
    const existing = await this.redisService.getSession(userId);
    if (!existing) {
      throw new NotFoundException(`Session not found for userId: ${userId}`);
    }
    await this.redisService.deleteSession(userId);
    this.logger.log(`[deleteSession] session deleted userId=${userId}`);
  }

  /**
   * 매장 검색 시작 시 세션 상태를 서버 주도로 동기화합니다.
   *
   * [리셋 조건] — 아래 중 하나라도 해당하면 예약 진행 필드를 초기화하고 SEARCHING으로 복귀합니다.
   *   1. 현재 세션 상태가 FAIL인 경우
   *   2. ctx.storeId가 존재하는데 기존 last_store_id와 다른 경우 (상태 무관 방어적 리셋)
   *   3. ctx.storeId 없이 새로운 역(station)으로 검색하는 경우
   *
   * 리셋은 patchCurrentSession을 직접 사용하여 상태 전이 검증을 우회합니다.
   * 이는 서버가 방어적으로 강제 복귀시키는 예외 경로이므로 AI 상태 전이 규칙을 적용하지 않습니다.
   *
   * [프로필 동기화] — station → preferred_station, preference → taste_tags 자동 저장
   *
   * [자동 승격] — 리셋/프로필 업데이트 후 세션에 last_store_id, selected_items(≥1개), pickup_time이
   *   모두 존재하고 현재 상태가 SEARCHING이면 READY_FOR_SUMMARY로 자동 전이합니다.
   */
  async syncSearchContext(ctx: SearchSyncContext): Promise<void> {
    const { userId, storeId, station, preference } = ctx;

    const session = await this.redisService.getSession(userId);
    const current = session?.current_session;
    const currentStatus = current?.status;

    // ── 리셋 조건 판별 ─────────────────────────────────────────────────────────
    const isFail = currentStatus === SessionStatus.FAIL;
    const isDifferentStore =
      storeId !== undefined && current?.last_store_id !== storeId;
    const isNewStation =
      storeId === undefined &&
      station !== undefined &&
      station !== session?.profile?.preferred_station;

    const shouldReset = isFail || isDifferentStore || isNewStation;

    if (shouldReset) {
      const reasons: string[] = [];
      if (isFail) reasons.push('FAIL status');
      if (isDifferentStore)
        reasons.push(`storeId changed (${current?.last_store_id} → ${storeId})`);
      if (isNewStation)
        reasons.push(`new station (${session?.profile?.preferred_station ?? 'none'} → ${station})`);

      // 상태 전이 검증을 우회하여 방어적 강제 리셋 수행
      await this.redisService.patchCurrentSession(userId, {
        status: SessionStatus.SEARCHING,
        selected_items: [],
        pickup_time: undefined,
        hold_token: undefined,
        last_error: undefined,
      });

      this.logger.log(
        `[syncSearchContext] userId=${userId} defensive reset: ${reasons.join(', ')}`,
      );
    }

    // ── 프로필 동기화 ──────────────────────────────────────────────────────────
    const profilePatch: { preferred_station?: string; taste_tags?: string[] } = {};
    if (station) profilePatch.preferred_station = station;
    if (preference && preference.length > 0) profilePatch.taste_tags = preference;

    if (Object.keys(profilePatch).length > 0) {
      await this.redisService.updateProfile(userId, profilePatch);
      this.logger.log(
        `[syncSearchContext] userId=${userId} profile synced` +
          (profilePatch.preferred_station ? ` station=${profilePatch.preferred_station}` : '') +
          (profilePatch.taste_tags ? ` taste_tags=${JSON.stringify(profilePatch.taste_tags)}` : ''),
      );
    }

    // ── 자동 승격: SEARCHING → READY_FOR_SUMMARY ──────────────────────────────
    // 필수 예약 정보가 모두 충족된 경우에만 수행. SEARCHING 상태일 때만 승격합니다.
    const updated = await this.redisService.getSession(userId);
    const cs = updated?.current_session;
    if (
      cs?.status === SessionStatus.SEARCHING &&
      cs?.last_store_id !== undefined &&
      (cs?.selected_items?.length ?? 0) >= 1 &&
      cs?.pickup_time !== undefined
    ) {
      await this.redisService.patchCurrentSession(userId, {
        status: SessionStatus.READY_FOR_SUMMARY,
      });
      this.logger.log(
        `[syncSearchContext] userId=${userId} auto-promoted SEARCHING → READY_FOR_SUMMARY`,
      );
    }
  }
}
