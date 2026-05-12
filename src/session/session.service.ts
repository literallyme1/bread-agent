import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { DataSource } from 'typeorm';
import { RedisHoldService } from '../redis/redis.service';
import {
  CurrentSession,
  RedisUserSession,
  RedisUserSessionSchema,
  SelectedItem,
  SessionStatus,
  SessionStatusType,
} from '../redis/session.schema';
import { Store } from '../store/entity/store.entity';
import { Inventory } from '../inventory/entity/inventory.entity';
import {
  parsePickupInstantFromClientString,
  isPickupInstantBeforeGraceThreshold,
  normalizePickupTimeForStorage,
} from '../common/utils/kst-pickup-time.util';

/**
 * patchSession이 수신하는 패치 페이로드.
 *
 * - current_session 필드만 수정합니다. profile(preferred_station, taste_tags)은 getStores에서 관리합니다.
 * - itemId + count: 단일 아이템의 최종 목표 수량을 지정합니다. selected_items와 동시에 사용 불가.
 *   count=0 이면 해당 아이템을 목록에서 제거합니다.
 */
export type SessionPatchPayload = Partial<CurrentSession> & {
  /** 수정할 아이템 ID. count와 함께 제공해야 합니다. */
  itemId?: number;
  /** 추가 시 필요한 아이템 이름. itemId가 목록에 없을 때 신규 항목으로 추가됩니다. */
  itemName?: string;
  /** 아이템의 최종 목표 수량(0 = 삭제). itemId와 함께 제공해야 합니다. */
  count?: number;
};

/**
 * syncSearchContext에 전달되는 검색 컨텍스트.
 * StoreQueryDto와 호환되는 구조이며, SessionService가 Store 모듈에 의존하지 않도록 별도 정의합니다.
 */
export interface SearchSyncContext {
  userId: string;
  /** AI가 현재 대화 중인 매장의 정확한 이름. last_store_name 대조의 우선 신호. */
  name?: string;
  /** 매장 DB ID. name이 없을 때 보조 대조 신호로 사용. */
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

  constructor(
    private readonly redisService: RedisHoldService,
    private readonly dataSource: DataSource,
  ) {}

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
   * Redis에 신규 예약 세션을 생성합니다.
   *
   * - `current_session.status`는 항상 SEARCHING으로 시작합니다.
   * - `selected_items`는 빈 배열입니다.
   * - 이미 세션이 존재하면 세션을 수정하지 않고 ConflictException(409)을 던집니다.
   */
  async createSession(userId: string): Promise<RedisUserSession> {
    const existing = await this.redisService.getSession(userId);
    if (existing) {
      throw new ConflictException(
        `Session already exists for userId: ${userId}. Use PATCH to update or DELETE before creating again.`,
      );
    }

    const draft: RedisUserSession = {
      current_session: {
        status: SessionStatus.SEARCHING,
        selected_items: [],
      },
    };

    const validated = RedisUserSessionSchema.safeParse(draft);
    if (!validated.success) {
      this.logger.error(
        `[createSession] schema validation failed userId=${userId}: ${validated.error.message}`,
      );
      throw new BadRequestException('Session data failed schema validation');
    }

    await this.redisService.setSession(userId, validated.data);
    this.logger.log(`[createSession] userId=${userId} created with status=SEARCHING`);

    return validated.data;
  }

  /**
   * 세션을 Upsert 방식으로 업데이트합니다.
   *
   * 세션이 없으면 기본 스키마({ status: SEARCHING, selected_items: [] })로 먼저 생성한 뒤 병합합니다.
   *
   * 처리 순서:
   *   1. Upsert: 세션 조회 → 없으면 기본 세션으로 초기화
   *   2. [A] 매장 정보 동기화: last_store_id → DB 조회 → last_store_name 자동 채움 (반대도 동일)
   *   3. [C] pickup_time 검증: 타임존 없으면 KST로 해석, 유예 5초. 저장 시 UTC·Z로 바꾸지 않고 오프셋 없으면 `+09:00`만 붙임
   *   4. [STEP 1] itemId + count 경로 — 기존 목록에서 해당 아이템 수량을 덮어씁니다(count=0이면 제거)
   *   5. [B] selected_items 경로 — 신규 아이템을 현재 매장 재고와 대조하여 유효성 검사
   *   6. itemId 경로가 아닐 때만 — READY_FOR_SUMMARY에서 정보 수집 필드 수정 시 SEARCHING으로 롤백
   *   7. itemId 경로가 아닐 때만 — 명시적 status 전이 규칙 검증
   *   8. 기존 세션에 병합
   *   9. [STEP 2] itemId 경로 한정 — 병합 후 selected_items가 비면 SEARCHING으로 강제 복귀
   *  10. [D] 공통 자동 승격 — SEARCHING + last_store_id + items(≥1) + pickup_time → READY_FOR_SUMMARY
   *  11. RedisUserSessionSchema.safeParse()로 최종 검증 후 Redis 저장
   */
  async patchSession(userId: string, payload: SessionPatchPayload): Promise<RedisUserSession> {
    // ── Upsert ───────────────────────────────────────────────────────────────────
    const rawExisting = await this.redisService.getSession(userId);
    const existing: RedisUserSession = rawExisting ?? {
      current_session: { status: SessionStatus.SEARCHING, selected_items: [] },
    };
    if (!rawExisting) {
      this.logger.log(`[patchSession] userId=${userId} session not found — auto-creating with SEARCHING defaults`);
    }

    // ── 필드 추출 ─────────────────────────────────────────────────────────────────
    const { itemId, itemName, count, ...currentSessionPatch } = payload;
    let patch = currentSessionPatch as Partial<CurrentSession>;

    // ── [A] 매장 정보 동기화 ──────────────────────────────────────────────────────
    // last_store_id → DB 조회 → last_store_name 자동 채움
    // last_store_name only → DB 조회 → last_store_id 자동 채움
    if (patch.last_store_id !== undefined) {
      const store = await this.dataSource
        .getRepository(Store)
        .findOne({ where: { id: patch.last_store_id }, select: ['id', 'name'] });
      if (!store) {
        throw new BadRequestException(
          `last_store_id=${patch.last_store_id}에 해당하는 매장을 찾을 수 없습니다. 올바른 매장 ID를 확인해주세요.`,
        );
      }
      patch = {
        ...patch,
        last_store_id: Number(store.id),
        last_store_name: store.name,
      };
      this.logger.log(`[patchSession] userId=${userId} [A] id=${store.id} → name="${store.name}"`);
    } else if (patch.last_store_name !== undefined) {
      const store = await this.dataSource
        .getRepository(Store)
        .findOne({ where: { name: patch.last_store_name }, select: ['id', 'name'] });
      if (!store) {
        throw new BadRequestException(
          `last_store_name="${patch.last_store_name}"에 해당하는 매장을 찾을 수 없습니다. 올바른 매장 이름을 확인해주세요.`,
        );
      }
      patch = {
        ...patch,
        last_store_id: Number(store.id),
        last_store_name: store.name,
      };
      this.logger.log(`[patchSession] userId=${userId} [A] name="${store.name}" → id=${store.id}`);
    }

    // ── [C] 픽업 시간 검증 (타임존 생략 시 KST 벽시각으로 해석) ─────────────────────
    // 저장: UTC Z로 바꾸지 않음. 오프셋 없으면 +09:00만 붙여 클라이언트가 보낸 시각을 유지한다.
    if (patch.pickup_time !== undefined) {
      const raw = String(patch.pickup_time);
      const pickupDate = parsePickupInstantFromClientString(raw);
      if (isPickupInstantBeforeGraceThreshold(pickupDate, 5_000)) {
        throw new BadRequestException(
          `pickup_time은 예약 가능한 시각이어야 합니다. (입력값: ${patch.pickup_time}, KST 기준 해석)`,
        );
      }
      patch = { ...patch, pickup_time: normalizePickupTimeForStorage(raw) };
    }

    // ── STEP 1: 아이템 단위 수량 덮어쓰기 ─────────────────────────────────────────
    let itemUpdateApplied = false;
    if (itemId !== undefined && count !== undefined) {
      const existingItems = existing.current_session?.selected_items ?? [];
      const resolvedItems = this.applyItemUpdate(existingItems, itemId, count, itemName, userId);
      patch = { ...patch, selected_items: resolvedItems };
      itemUpdateApplied = true;
      this.logger.log(
        `[patchSession] userId=${userId} item update: id=${itemId} count=${count}` +
          ` → items.length=${resolvedItems.length}`,
      );
    }

    // ── [B] 장바구니 유효성 검사 (selected_items 전달 시만 수행) ─────────────────────
    // itemId 경로는 단순 수량 업데이트이므로 무거운 검증 생략.
    // 기존 세션에 없는 신규 아이템 ID만 현재 매장 재고와 대조합니다.
    if (patch.selected_items !== undefined && !itemUpdateApplied) {
      const resolvedStoreId = patch.last_store_id ?? existing.current_session?.last_store_id;
      if (resolvedStoreId !== undefined && patch.selected_items.length > 0) {
        const existingItemIds = new Set(
          (existing.current_session?.selected_items ?? []).map((i) => Number(i.id)),
        );
        const newItems = patch.selected_items.filter(
          (item) => !existingItemIds.has(Number(item.id)),
        );

        if (newItems.length > 0) {
          // PostgreSQL bigint → 드라이버에 따라 breadId가 string으로 올 수 있음.
          // JSON의 item.id는 number라 Set.has()가 실패하지 않도록 숫자로 통일한다.
          const storeIdNum = Number(resolvedStoreId);
          const inventoryRows = await this.dataSource
            .getRepository(Inventory)
            .find({ where: { storeId: storeIdNum }, select: ['breadId'] });
          const validBreadIds = new Set(
            inventoryRows.map((row) => Number(row.breadId)),
          );

          const invalidItems = newItems.filter(
            (item) => !validBreadIds.has(Number(item.id)),
          );
          if (invalidItems.length > 0) {
            throw new BadRequestException(
              `다음 아이템은 매장(ID=${resolvedStoreId})에 존재하지 않는 메뉴입니다: ` +
                invalidItems.map((i) => `${i.name}(ID=${i.id})`).join(', '),
            );
          }
          this.logger.log(
            `[patchSession] userId=${userId} [B] ${newItems.length}개 신규 아이템 재고 검증 통과`,
          );
        }
      }
    }

    // ── SUMMARY_INVALIDATING 롤백 (itemId 경로 제외) ─────────────────────────────
    const currentStatus =
      rawExisting !== null
        ? rawExisting?.current_session?.status
        : SessionStatus.SEARCHING;

    if (
      !itemUpdateApplied &&
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

    // ── 명시적 status 전이 검증 (itemId 경로 제외) ────────────────────────────────
    if (!itemUpdateApplied && patch.status !== undefined) {
      this.validateTransition(currentStatus, patch.status, userId);
    }

    // ── 병합 ──────────────────────────────────────────────────────────────────────
    let mergedSession: CurrentSession = {
      ...existing.current_session,
      ...patch,
    } as CurrentSession;

    // ── STEP 2: Fallback — 아이템이 비면 SEARCHING으로 강제 복귀 ─────────────────
    if (itemUpdateApplied && (mergedSession.selected_items?.length ?? 0) === 0) {
      mergedSession = {
        ...mergedSession,
        status: SessionStatus.SEARCHING,
        pickup_time: undefined,
        hold_token: undefined,
      };
      this.logger.log(`[patchSession] userId=${userId} auto-fallback: SEARCHING (selected_items empty)`);
    }

    // ── [D] 자동 승격: SEARCHING → READY_FOR_SUMMARY (모든 경로 공통) ────────────
    // 모든 필수 예약 정보가 충족된 경우 AI 호출 없이 서버가 직접 승격합니다.
    else if (
      mergedSession.status === SessionStatus.SEARCHING &&
      mergedSession.last_store_id !== undefined &&
      (mergedSession.selected_items?.length ?? 0) >= 1 &&
      mergedSession.pickup_time !== undefined
    ) {
      mergedSession = { ...mergedSession, status: SessionStatus.READY_FOR_SUMMARY };
      this.logger.log(`[patchSession] userId=${userId} [D] auto-promoted: SEARCHING → READY_FOR_SUMMARY`);
    }

    // Store/Inventory bigint → 드라이버에 따라 문자열이 섞이면 Redis Zod 스키마(z.number())가 실패한다.
    mergedSession = this.normalizeCurrentSessionNumericIds(mergedSession);

    // ── Schema 검증 + 저장 ────────────────────────────────────────────────────────
    const updated: RedisUserSession = {
      profile: existing.profile,
      current_session: mergedSession,
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
      `[patchSession] userId=${userId} saved fields=[${Object.keys(payload).join(', ')}]` +
        ` status=${validated.data.current_session?.status}`,
    );

    return validated.data;
  }

  /**
   * PostgreSQL bigint 등으로 last_store_id·아이템 id가 문자열로 섞이면
   * RedisUserSessionSchema의 z.number() 검증이 실패한다. 저장 직전에 숫자로 통일한다.
   */
  private normalizeCurrentSessionNumericIds(session: CurrentSession): CurrentSession {
    let next: CurrentSession = { ...session };
    if (next.last_store_id !== undefined && next.last_store_id !== null) {
      next = { ...next, last_store_id: Number(next.last_store_id) };
    }
    if (next.selected_items?.length) {
      next = {
        ...next,
        selected_items: next.selected_items.map((it) => ({
          ...it,
          id: Number(it.id),
          count: Number(it.count),
        })),
      };
    }
    return next;
  }

  /**
   * 기존 selected_items 목록에 단일 아이템 업데이트를 적용합니다.
   *
   * - count > 0 + 아이템 존재: 수량을 count로 덮어씁니다.
   * - count > 0 + 아이템 없음 + itemName 제공: 신규 아이템으로 목록에 추가합니다.
   * - count > 0 + 아이템 없음 + itemName 미제공: 400 BadRequestException을 던집니다.
   * - count === 0: 해당 아이템을 목록에서 제거합니다.
   */
  private applyItemUpdate(
    items: SelectedItem[],
    itemId: number,
    count: number,
    itemName: string | undefined,
    userId: string,
  ): SelectedItem[] {
    if (count <= 0) {
      return items.filter((item) => item.id !== itemId);
    }

    const existingIndex = items.findIndex((item) => item.id === itemId);

    if (existingIndex >= 0) {
      return items.map((item) => (item.id === itemId ? { ...item, count } : item));
    }

    // 목록에 없는 신규 아이템: itemName 필수
    if (!itemName) {
      throw new BadRequestException(
        `itemId=${itemId}은 현재 선택 목록에 없는 신규 아이템입니다. 신규 추가 시 itemName을 함께 제공해야 합니다.`,
      );
    }

    return [...items, { id: itemId, name: itemName, count }];
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
   * ─ 최적화 선행 체크 ───────────────────────────────────────────────────────
   * [Case A: SEARCHING 상태]
   *   이미 검색 중인 세션이므로 리셋이 불필요합니다.
   *   새로 들어온 검색 정보(name, storeId)만 세션에 덮어쓰고,
   *   4가지 시나리오 판별을 건너뜁니다.
   *   프로필 동기화 및 자동 승격은 이후 공통 처리에서 수행됩니다.
   *
   * ─ 4가지 시나리오 (status ≠ SEARCHING일 때만 진입) ──────────────────────
   *
   * [시나리오 1: 새로운 검색]
   *   name / storeId 없이 기존과 다른 station만 들어온 경우.
   *   예약 정보 전체(매장·아이템·시간·토큰) 초기화 + status = SEARCHING.
   *
   * [시나리오 2: 매장 변경]
   *   ctx.name이 존재하고 기존 last_store_name과 다른 경우 (name 우선).
   *   또는 ctx.storeId가 기존 last_store_id와 다른 경우 (보조 신호).
   *   장바구니·시간·토큰 초기화 + 새 매장 정보(name / storeId)로 업데이트.
   *
   * [시나리오 3: 실패 복구]
   *   현재 status === FAIL인 경우. 묻지도 따지지도 않고 예약 진행 데이터 강제 리셋.
   *   (last_store_id / last_store_name은 유지하여 AI가 재시도 맥락을 파악할 수 있게 함)
   *
   * [시나리오 4: 매장 유지]
   *   name 또는 storeId가 기존 정보와 일치하면 아무것도 초기화하지 않습니다.
   *   기존 장바구니와 픽업 시간을 그대로 유지합니다.
   *
   * ─ 공통 처리 ─────────────────────────────────────────────────────────────
   * [프로필 동기화] station → preferred_station, preference → taste_tags
   * [자동 승격]    last_store_id + selected_items(≥1) + pickup_time 모두 존재
   *               하고 status === SEARCHING이면 READY_FOR_SUMMARY로 자동 전이.
   *
   * 리셋은 patchCurrentSession으로 상태 전이 검증을 우회합니다.
   * 서버가 방어적으로 강제 복귀시키는 예외 경로이므로 AI 규칙을 적용하지 않습니다.
   */
  async syncSearchContext(ctx: SearchSyncContext): Promise<void> {
    const { userId, name, storeId, station, preference } = ctx;

    const session = await this.redisService.getSession(userId);
    const current = session?.current_session;
    const currentStatus = current?.status;

    // ── 최적화 선행 체크: SEARCHING 상태면 리셋 없이 검색 정보만 덮어쓰기 ────────
    if (currentStatus === SessionStatus.SEARCHING) {
      const overwritePatch: Partial<import('../redis/session.schema').CurrentSession> = {};
      if (name !== undefined) overwritePatch.last_store_name = name;
      if (storeId !== undefined) overwritePatch.last_store_id = storeId;

      if (Object.keys(overwritePatch).length > 0) {
        await this.redisService.patchCurrentSession(userId, overwritePatch);
      }

      this.logger.log(
        `[syncSearchContext] userId=${userId} Case A — already SEARCHING, overwrite only` +
          (name ? ` name="${name}"` : '') +
          (storeId ? ` storeId=${storeId}` : ''),
      );
    } else {
      // ── 시나리오 판별 (status ≠ SEARCHING) ────────────────────────────────────

      // [시나리오 3] FAIL — 무조건 리셋 (최우선)
      const isFail = currentStatus === SessionStatus.FAIL;

      // [시나리오 2] 매장 변경 — name 대조 우선, storeId 보조
      const isNameMismatch =
        !!name &&
        !!current?.last_store_name &&
        name !== current.last_store_name;

      const isIdMismatch =
        storeId !== undefined &&
        current?.last_store_id !== undefined &&
        storeId !== current.last_store_id;

      const isStoreMismatch = isNameMismatch || isIdMismatch;

      // [시나리오 1] 새로운 검색 — name/storeId 없이 새로운 station
      const isNewSearch =
        !name &&
        !storeId &&
        station !== undefined &&
        station !== session?.profile?.preferred_station;

      // [시나리오 4] 매장 유지 — 위 조건 중 아무것도 해당 없음

      const shouldReset = isFail || isStoreMismatch || isNewSearch;

      if (shouldReset) {
        const reasons: string[] = [];
        if (isFail) reasons.push('FAIL status');
        if (isNameMismatch) reasons.push(`name changed ("${current?.last_store_name}" → "${name}")`);
        if (isIdMismatch) reasons.push(`storeId changed (${current?.last_store_id} → ${storeId})`);
        if (isNewSearch) reasons.push(`new station (${session?.profile?.preferred_station ?? 'none'} → ${station})`);

        // 공통 리셋 필드 (예약 진행 데이터)
        const resetPatch: Partial<import('../redis/session.schema').CurrentSession> = {
          status: SessionStatus.SEARCHING,
          selected_items: [],
          pickup_time: undefined,
          hold_token: undefined,
          last_error: undefined,
        };

        if (isStoreMismatch) {
          // 시나리오 2: 신규 매장 정보로 교체
          resetPatch.last_store_name = name ?? undefined;
          resetPatch.last_store_id = storeId;
        } else if (isNewSearch) {
          // 시나리오 1: 매장 정보까지 완전 초기화
          resetPatch.last_store_id = undefined;
          resetPatch.last_store_name = undefined;
        }
        // 시나리오 3 (FAIL): last_store_id / last_store_name 유지 (재시도 맥락 보존)

        await this.redisService.patchCurrentSession(userId, resetPatch);
        this.logger.log(
          `[syncSearchContext] userId=${userId} reset [${reasons.join(' | ')}]`,
        );
      } else {
        this.logger.log(
          `[syncSearchContext] userId=${userId} scenario 4 — store retained` +
            (current?.last_store_name ? ` store="${current.last_store_name}"` : ''),
        );
      }
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
