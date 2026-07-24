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
import {
  getAllowedServerStateTransitions,
  isServerStateTransitionAllowed,
} from './session-state.validator';

export type SessionPatchPayload = Partial<CurrentSession> & {
  itemId?: number;
  itemName?: string;
  count?: number;
};

export interface SearchSyncContext {
  userId: string;
  name?: string;
  storeId?: number;
  station?: string;
  preference?: string[];
}

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

  /** 사용자의 Redis 예약 세션을 조회한다. */
  async getSession(userId: string): Promise<RedisUserSession> {
    const session = await this.redisService.getSession(userId);
    if (!session) {
      throw new NotFoundException(`Session not found for userId: ${userId}`);
    }
    return session;
  }

  /** SEARCHING 상태의 신규 예약 세션을 생성한다. */
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
    this.logger.log(
      `[createSession] userId=${userId} created with status=SEARCHING`,
    );

    return validated.data;
  }

  /** 예약 입력을 검증·정규화하고 서버 상태 머신을 적용해 세션을 갱신한다. */
  async patchSession(
    userId: string,
    payload: SessionPatchPayload,
  ): Promise<RedisUserSession> {
    const rawExisting = await this.redisService.getSession(userId);
    const existing: RedisUserSession = rawExisting ?? {
      current_session: { status: SessionStatus.SEARCHING, selected_items: [] },
    };
    if (!rawExisting) {
      this.logger.log(
        `[patchSession] userId=${userId} session not found — auto-creating with SEARCHING defaults`,
      );
    }

    const { itemId, itemName, count, ...currentSessionPatch } = payload;
    let patch = currentSessionPatch as Partial<CurrentSession>;

    if (patch.last_store_id !== undefined) {
      const store = await this.dataSource.getRepository(Store).findOne({
        where: { id: patch.last_store_id },
        select: ['id', 'name'],
      });
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
      this.logger.log(
        `[patchSession] userId=${userId} [A] id=${store.id} → name="${store.name}"`,
      );
    } else if (patch.last_store_name !== undefined) {
      const store = await this.dataSource.getRepository(Store).findOne({
        where: { name: patch.last_store_name },
        select: ['id', 'name'],
      });
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
      this.logger.log(
        `[patchSession] userId=${userId} [A] name="${store.name}" → id=${store.id}`,
      );
    }

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

    let itemQuantityUpdated = false;
    if (itemId !== undefined && count !== undefined) {
      const existingItems = existing.current_session?.selected_items ?? [];
      const resolvedItems = this.applyRequestedItemQuantity(
        existingItems,
        itemId,
        count,
        itemName,
      );
      patch = { ...patch, selected_items: resolvedItems };
      itemQuantityUpdated = true;
      this.logger.log(
        `[patchSession] userId=${userId} item update: id=${itemId} count=${count}` +
          ` → items.length=${resolvedItems.length}`,
      );
    }

    if (patch.selected_items !== undefined && !itemQuantityUpdated) {
      const resolvedStoreId =
        patch.last_store_id ?? existing.current_session?.last_store_id;
      if (resolvedStoreId !== undefined && patch.selected_items.length > 0) {
        const existingItemIds = new Set(
          (existing.current_session?.selected_items ?? []).map((i) =>
            Number(i.id),
          ),
        );
        const newItems = patch.selected_items.filter(
          (item) => !existingItemIds.has(Number(item.id)),
        );

        if (newItems.length > 0) {
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

    const currentStatus =
      rawExisting !== null
        ? rawExisting?.current_session?.status
        : SessionStatus.SEARCHING;

    if (
      !itemQuantityUpdated &&
      currentStatus === SessionStatus.READY_FOR_SUMMARY &&
      patch.status === undefined &&
      SUMMARY_INVALIDATING_FIELDS.some((field) => field in patch)
    ) {
      const invalidatedFields = SUMMARY_INVALIDATING_FIELDS.filter(
        (f) => f in patch,
      );
      patch = { ...patch, status: SessionStatus.SEARCHING };
      this.logger.log(
        `[patchSession] userId=${userId} READY_FOR_SUMMARY → SEARCHING auto-rollback` +
          ` (modified fields: [${invalidatedFields.join(', ')}])`,
      );
    }

    if (!itemQuantityUpdated && patch.status !== undefined) {
      this.assertServerStateTransition(currentStatus, patch.status, userId);
    }

    let mergedSession: CurrentSession = {
      ...existing.current_session,
      ...patch,
    };

    if (
      itemQuantityUpdated &&
      (mergedSession.selected_items?.length ?? 0) === 0
    ) {
      mergedSession = {
        ...mergedSession,
        status: SessionStatus.SEARCHING,
        pickup_time: undefined,
        hold_token: undefined,
      };
      this.logger.log(
        `[patchSession] userId=${userId} auto-fallback: SEARCHING (selected_items empty)`,
      );
    } else if (
      mergedSession.status === SessionStatus.SEARCHING &&
      this.hasCompleteReservationContext(mergedSession)
    ) {
      mergedSession = {
        ...mergedSession,
        status: SessionStatus.READY_FOR_SUMMARY,
      };
      this.logger.log(
        `[patchSession] userId=${userId} [D] auto-promoted: SEARCHING → READY_FOR_SUMMARY`,
      );
    }

    mergedSession = this.normalizeSessionEntityIds(mergedSession);

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

  /** DB 식별자를 Redis 세션 스키마에 맞는 숫자로 정규화한다. */
  private normalizeSessionEntityIds(session: CurrentSession): CurrentSession {
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

  /** 장바구니에 사용자가 요청한 최종 아이템 수량을 반영한다. */
  private applyRequestedItemQuantity(
    items: SelectedItem[],
    itemId: number,
    count: number,
    itemName: string | undefined,
  ): SelectedItem[] {
    if (count <= 0) {
      return items.filter((item) => item.id !== itemId);
    }

    const existingIndex = items.findIndex((item) => item.id === itemId);

    if (existingIndex >= 0) {
      return items.map((item) =>
        item.id === itemId ? { ...item, count } : item,
      );
    }

    if (!itemName) {
      throw new BadRequestException(
        `itemId=${itemId}은 현재 선택 목록에 없는 신규 아이템입니다. 신규 추가 시 itemName을 함께 제공해야 합니다.`,
      );
    }

    return [...items, { id: itemId, name: itemName, count }];
  }

  /** 요청된 상태 변경이 서버 상태 머신에서 허용되는지 검증한다. */
  private assertServerStateTransition(
    current: SessionStatusType | undefined,
    next: SessionStatusType,
    userId: string,
  ): void {
    if (current === undefined) {
      return;
    }

    if (!isServerStateTransitionAllowed(current, next)) {
      const allowed = getAllowedServerStateTransitions(current).join(', ');
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

  /** 사용자 프로필을 보존하며 예약 진행 상태를 SEARCHING으로 초기화한다. */
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

  /** 사용자의 Redis 예약 세션을 삭제한다. */
  async deleteSession(userId: string): Promise<void> {
    const existing = await this.redisService.getSession(userId);
    if (!existing) {
      throw new NotFoundException(`Session not found for userId: ${userId}`);
    }
    await this.redisService.deleteSession(userId);
    this.logger.log(`[deleteSession] session deleted userId=${userId}`);
  }

  /** 합성 매장 검색 결과를 프로필과 서버 예약 상태에 동기화한다. */
  async syncSearchContext(ctx: SearchSyncContext): Promise<void> {
    const { userId, name, storeId, station, preference } = ctx;

    const session = await this.redisService.getSession(userId);
    const current = session?.current_session;
    const currentStatus = current?.status;

    if (currentStatus === SessionStatus.SEARCHING) {
      const overwritePatch: Partial<
        import('../redis/session.schema').CurrentSession
      > = {};
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
      const isFail = currentStatus === SessionStatus.FAIL;

      const isNameMismatch =
        !!name &&
        !!current?.last_store_name &&
        name !== current.last_store_name;

      const isIdMismatch =
        storeId !== undefined &&
        current?.last_store_id !== undefined &&
        storeId !== current.last_store_id;

      const isStoreMismatch = isNameMismatch || isIdMismatch;

      const isNewSearch =
        !name &&
        !storeId &&
        station !== undefined &&
        station !== session?.profile?.preferred_station;

      const shouldReset = isFail || isStoreMismatch || isNewSearch;

      if (shouldReset) {
        const reasons: string[] = [];
        if (isFail) reasons.push('FAIL status');
        if (isNameMismatch)
          reasons.push(
            `name changed ("${current?.last_store_name}" → "${name}")`,
          );
        if (isIdMismatch)
          reasons.push(
            `storeId changed (${current?.last_store_id} → ${storeId})`,
          );
        if (isNewSearch)
          reasons.push(
            `new station (${session?.profile?.preferred_station ?? 'none'} → ${station})`,
          );

        const resetPatch: Partial<
          import('../redis/session.schema').CurrentSession
        > = {
          status: SessionStatus.SEARCHING,
          selected_items: [],
          pickup_time: undefined,
          hold_token: undefined,
          last_error: undefined,
        };

        if (isStoreMismatch) {
          resetPatch.last_store_name = name ?? undefined;
          resetPatch.last_store_id = storeId;
        } else if (isNewSearch) {
          resetPatch.last_store_id = undefined;
          resetPatch.last_store_name = undefined;
        }

        await this.redisService.patchCurrentSession(userId, resetPatch);
        this.logger.log(
          `[syncSearchContext] userId=${userId} reset [${reasons.join(' | ')}]`,
        );
      } else {
        this.logger.log(
          `[syncSearchContext] userId=${userId} scenario 4 — store retained` +
            (current?.last_store_name
              ? ` store="${current.last_store_name}"`
              : ''),
        );
      }
    }

    const profilePatch: { preferred_station?: string; taste_tags?: string[] } =
      {};
    if (station) profilePatch.preferred_station = station;
    if (preference && preference.length > 0)
      profilePatch.taste_tags = preference;

    if (Object.keys(profilePatch).length > 0) {
      await this.redisService.updateProfile(userId, profilePatch);
      this.logger.log(
        `[syncSearchContext] userId=${userId} profile synced` +
          (profilePatch.preferred_station
            ? ` station=${profilePatch.preferred_station}`
            : '') +
          (profilePatch.taste_tags
            ? ` taste_tags=${JSON.stringify(profilePatch.taste_tags)}`
            : ''),
      );
    }

    const updated = await this.redisService.getSession(userId);
    const cs = updated?.current_session;
    if (
      cs?.status === SessionStatus.SEARCHING &&
      this.hasCompleteReservationContext(cs)
    ) {
      await this.redisService.patchCurrentSession(userId, {
        status: SessionStatus.READY_FOR_SUMMARY,
      });
      this.logger.log(
        `[syncSearchContext] userId=${userId} auto-promoted SEARCHING → READY_FOR_SUMMARY`,
      );
    }
  }

  /** 예약 요약으로 승격할 필수 매장·아이템·픽업 정보가 모두 있는지 확인한다. */
  private hasCompleteReservationContext(session: CurrentSession): boolean {
    return (
      session.last_store_id !== undefined &&
      (session.selected_items?.length ?? 0) >= 1 &&
      session.pickup_time !== undefined
    );
  }
}
