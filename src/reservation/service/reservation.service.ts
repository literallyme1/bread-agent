import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { randomUUID } from 'crypto';
import { ReservationRepository } from '../repository/reservation.repository';
import { InventoryRepository } from '../../inventory/repository/inventory.repository';
import { StoreRepository } from '../../store/repository/store.repository';
import { RedisHoldService, HoldData, HOLD_TTL_SECONDS } from '../../redis/redis.service';
import { SessionStatus } from '../../redis/session.schema';
import { ConfirmHoldDto } from '../dto/confirm-hold.dto';
import { CancelReservationDto } from '../dto/cancel-reservation.dto';
import { HoldResponseDto, HoldItemResultDto } from '../dto/hold-response.dto';
import {
  ConfirmReservationResponseDto,
  ReservationResponseDto,
  CancelReservationResponseDto,
} from '../dto/reservation-response.dto';
import { ReservationListEntry, toReservationListEntry } from '../dto/reservation-list.dto';
import { Reservation, ReservationStatus } from '../entity/reservation.entity';
import { ReservationItem } from '../entity/reservation-item.entity';
import { CustomException } from '../../common/exception/custom.exception';
import { ErrorCode } from '../../common/exception/error-code.enum';
import { Store } from '../../store/entity/store.entity';
import {
  parsePickupInstantFromClientString,
  isPickupInstantBeforeGraceThreshold,
} from '../../common/utils/kst-pickup-time.util';

const KST_IANA = 'Asia/Seoul';

function parseTimeToMinutes(time: string): number {
  const [hourText, minuteText] = time.split(':');
  const hour = Number(hourText);
  const minute = Number(minuteText);

  if (
    Number.isNaN(hour) ||
    Number.isNaN(minute) ||
    hour < 0 ||
    hour > 23 ||
    minute < 0 ||
    minute > 59
  ) {
    throw new CustomException(ErrorCode.INVALID_PICKUP_TIME);
  }

  return hour * 60 + minute;
}

/** 매장 영업 시간(open/close)은 픽업 시각의 `Asia/Seoul` 벽시계 시·분으로 판단합니다. */
function getWallMinutesInTimeZone(date: Date, timeZone: string): number {
  const dtf = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  let hour = 0;
  let minute = 0;
  for (const p of dtf.formatToParts(date)) {
    if (p.type === 'hour') hour = Number(p.value);
    if (p.type === 'minute') minute = Number(p.value);
  }
  return hour * 60 + minute;
}

function validateStoreBusinessHoursSeoul(pickupTime: Date, store: Store): void {
  const pickupMinutes = getWallMinutesInTimeZone(pickupTime, KST_IANA);
  const openMinutes = parseTimeToMinutes(store.openTime);
  const closeMinutes = parseTimeToMinutes(store.closeTime);

  if (pickupMinutes < openMinutes || pickupMinutes >= closeMinutes) {
    throw new CustomException(ErrorCode.STORE_CLOSED);
  }
}

@Injectable()
export class ReservationService {
  private readonly logger = new Logger(ReservationService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly reservationRepository: ReservationRepository,
    private readonly inventoryRepository: InventoryRepository,
    private readonly storeRepository: StoreRepository,
    private readonly redisHoldService: RedisHoldService,
  ) {}

  /**
   * POST /v1/reservations/hold — Thin API (요청 바디 없음)
   *
   * Redis 세션의 `last_store_id`, `selected_items`, `pickup_time`만 사용합니다.
   *
   * [선 검증]
   *   1. 세션 존재 + 필수 필드 일괄 (없으면 400)
   *   2. 픽업 시각: **타임존 없는 값은 KST 벽시각**으로 해석 후, [현재 − 5초] 이전이면 400 ("예약 가능한 시간이 지났습니다")
   *   3. 사용자·매장 존재 + 영업시간(픽업 시각의 Asia/Seoul 벽시계 기준)
   *   4. 전체 아이템 재고 All-or-Nothing 선검증
   *
   * [성공] hold_token 발급 + 세션 WAITING_FOR_CONFIRM
   * [실패] Hold 미생성 + 세션 FAIL + last_error
   */
  async holdReservation(userId: string): Promise<HoldResponseDto> {
    const userKey = userId.trim();
    const numericUserId = Number(userKey);
    if (!userKey || Number.isNaN(numericUserId) || !Number.isInteger(numericUserId)) {
      throw new BadRequestException('유효한 userId가 필요합니다.');
    }

    const session = await this.redisHoldService.getSession(userKey);
    const cs = session?.current_session;

    if (!cs) {
      throw new BadRequestException(
        '예약 세션이 없습니다. 먼저 patchSession으로 매장·메뉴·픽업 시간을 저장해 주세요.',
      );
    }

    const storeId = cs.last_store_id !== undefined && cs.last_store_id !== null ? Number(cs.last_store_id) : undefined;
    const pickupRaw = cs.pickup_time;
    const items = cs.selected_items ?? [];

    if (storeId === undefined || Number.isNaN(storeId) || items.length === 0 || !pickupRaw) {
      throw new BadRequestException(
        'Redis 세션에 last_store_id, selected_items(1개 이상), pickup_time이 모두 필요합니다.',
      );
    }

    const pickupTime = parsePickupInstantFromClientString(String(pickupRaw));
    if (isPickupInstantBeforeGraceThreshold(pickupTime, 5_000)) {
      throw new BadRequestException('예약 가능한 시간이 지났습니다');
    }

    const user = await this.reservationRepository.findUserById(numericUserId);
    if (!user) throw new CustomException(ErrorCode.USER_NOT_FOUND);

    const store = await this.storeRepository.findById(storeId);
    if (!store) throw new CustomException(ErrorCode.STORE_NOT_FOUND);
    validateStoreBusinessHoursSeoul(pickupTime, store);

    // ── 선 검증: 전체 아이템 재고 확인 ─────────────────────────────────────
    const heldItems: HoldData['items'] = [];
    const resultItems: HoldItemResultDto[] = [];

    for (const line of items) {
      const breadId = Number(line.id);
      const qty = Number(line.count);
      if (!Number.isInteger(breadId) || breadId < 1 || !Number.isInteger(qty) || qty < 1) {
        throw new BadRequestException(
          `selected_items 항목이 올바르지 않습니다: id=${line.id}, count=${line.count}`,
        );
      }

      const inventory = await this.inventoryRepository.findByStoreAndBread(storeId, breadId);
      const breadName = inventory?.bread?.name ?? line.name ?? `빵 #${breadId}`;

      if (!inventory || inventory.available < qty) {
        const remaining = inventory?.available ?? 0;
        resultItems.push({
          id: String(breadId),
          name: breadName,
          requestedCount: qty,
          heldCount: 0,
          status: 'OUT_OF_STOCK',
          reason: `재고 부족 (남은 수량: ${remaining}개)`,
        });
        continue;
      }

      heldItems.push({
        inventoryId: Number(inventory.id),
        breadId,
        breadName,
        requestedQty: qty,
        heldQty: qty,
      });

      resultItems.push({
        id: String(breadId),
        name: breadName,
        requestedCount: qty,
        heldCount: qty,
        status: 'SUCCESS',
      });
    }

    const allHeld = heldItems.length === items.length;

    if (allHeld) {
      const holdToken = randomUUID();
      const expiresAt = new Date(Date.now() + HOLD_TTL_SECONDS * 1000).toISOString();

      await this.redisHoldService.createHold(holdToken, {
        userId: numericUserId,
        storeId,
        pickupTime: pickupTime.toISOString(),
        items: heldItems,
        expiresAt,
      });

      await this.redisHoldService.patchCurrentSession(userKey, {
        last_store_id: storeId,
        last_store_name: store.name,
        hold_token: holdToken,
        status: SessionStatus.WAITING_FOR_CONFIRM,
        last_error: undefined,
      });

      this.logger.log(
        `[holdReservation] ALL held → WAITING_FOR_CONFIRM` +
          ` userId=${userKey} holdToken=${holdToken} items=${heldItems.length}`,
      );

      return { success: true, holdToken, items: resultItems };
    }

    const failedSummary = resultItems
      .filter((item) => item.status !== 'SUCCESS')
      .map((item) => `${item.name}: ${item.reason}`)
      .join(' / ');

    await this.redisHoldService.patchCurrentSession(userKey, {
      status: SessionStatus.FAIL,
      last_error: `일부 상품의 재고가 부족합니다 — ${failedSummary}`,
    });

    this.logger.warn(
      `[holdReservation] FAIL userId=${userKey}` +
        ` (held=${heldItems.length}/${items.length}) ${failedSummary}`,
    );

    return { success: false, holdToken: null, items: resultItems };
  }

  /**
   * POST /v1/reservations/confirm
   *
   * 1. Redis에서 holdToken 조회 (없으면 만료/미존재 → EXPIRED 전이 후 에러)
   * 2. userId 일치 확인
   * 3. DB 트랜잭션: 재고 차감 → Reservation 생성 → ReservationItem 생성
   * 4. Redis Hold 삭제
   * 5. Redis 세션 전체 삭제 (AI 인사 후 재사용을 위해 완전히 제거)
   * 6. Store 정보를 포함한 풍부한 응답 반환 (AI가 인사 메시지 구성에 활용)
   */
  async confirmHold(dto: ConfirmHoldDto): Promise<ConfirmReservationResponseDto> {
    const holdData = await this.redisHoldService.getHold(dto.holdToken);

    if (!holdData) {
      // Hold TTL 만료 또는 존재하지 않는 토큰 → 세션을 EXPIRED로 전이 후 에러 반환
      await this.redisHoldService.patchCurrentSession(String(dto.userId), {
        status: SessionStatus.EXPIRED,
      });
      this.logger.warn(
        `[confirmHold] hold not found → session EXPIRED userId=${dto.userId} holdToken=${dto.holdToken}`,
      );
      throw new CustomException(ErrorCode.HOLD_EXPIRED);
    }

    if (holdData.userId !== dto.userId) throw new CustomException(ErrorCode.HOLD_USER_MISMATCH);

    const store = await this.storeRepository.findById(holdData.storeId);
    if (!store) throw new CustomException(ErrorCode.STORE_NOT_FOUND);

    const pickupTime = new Date(holdData.pickupTime);

    const savedReservation = await this.dataSource.transaction(async (manager) => {
      for (const item of holdData.items) {
        await this.inventoryRepository.decreaseStock(item.inventoryId, item.heldQty, manager);
      }

      const reservation = manager.getRepository(Reservation).create({
        userId: holdData.userId,
        status: ReservationStatus.CONFIRMED,
        pickupTime,
      });
      const saved = await this.reservationRepository.save(reservation, manager);

      const savedItems: ReservationItem[] = [];
      for (const item of holdData.items) {
        const resItem = manager.getRepository(ReservationItem).create({
          reservationId: saved.id,
          inventoryId: item.inventoryId,
          qty: item.heldQty,
        });
        const savedItem = await this.reservationRepository.saveItem(resItem, manager);
        savedItems.push(savedItem);
      }

      saved.items = savedItems;
      return saved;
    });

    // Hold 삭제 + Redis 세션 전체 삭제
    // 세션을 리셋이 아닌 삭제하여, 다음 대화 시작 시 완전히 새로운 세션으로 시작합니다.
    await this.redisHoldService.deleteHold(dto.holdToken);
    await this.redisHoldService.deleteSession(String(dto.userId));

    this.logger.log(
      `[confirmHold] confirmed userId=${dto.userId} reservationId=${savedReservation.id}` +
        ` store="${store.name}" — session deleted`,
    );

    return ConfirmReservationResponseDto.from(savedReservation, holdData, store);
  }

  async getReservation(id: number): Promise<ReservationResponseDto> {
    const reservation = await this.reservationRepository.findByIdWithItems(id);
    if (!reservation) throw new CustomException(ErrorCode.RESERVATION_NOT_FOUND);
    return ReservationResponseDto.from(reservation);
  }

  /**
   * GET /v1/reservations
   *
   * [지능형 필터] 서버가 자동으로 아래 조건을 적용합니다:
   *   - status = CONFIRMED (확정된 예약만)
   *   - pickupTime > 현재 시각 (미래 픽업만)
   *
   * [Side-Effect] 취소 가능한 예약이 1건 이상 존재하면
   *   Redis 세션을 WAITING_FOR_CANCELLING_CONFIRM으로 자동 전이합니다.
   *   AI는 이 상태를 보고 취소 흐름을 시작할 수 있습니다.
   */
  async getReservationList(userId: number): Promise<ReservationListEntry[]> {
    const confirmed = await this.reservationRepository.findByUserIdAndStatus(
      userId,
      ReservationStatus.CONFIRMED,
    );

    const now = new Date();
    const cancellable = confirmed.filter((r) => r.pickupTime > now);

    if (cancellable.length > 0) {
      await this.redisHoldService.patchCurrentSession(String(userId), {
        status: SessionStatus.WAITING_FOR_CANCELLING_CONFIRM,
      });
      this.logger.log(
        `[getReservationList] userId=${userId} cancellable=${cancellable.length}` +
          ` → session WAITING_FOR_CANCELLING_CONFIRM`,
      );
    } else {
      this.logger.log(
        `[getReservationList] userId=${userId} no cancellable reservations`,
      );
    }

    return cancellable.map(toReservationListEntry);
  }

  /**
   * 예약 취소
   * 1. 예약 존재 확인
   * 2. 요청 사용자 권한 확인
   * 3. 도메인 cancel() 호출 (상태 전이 규칙 적용)
   * 4. pickup 기준 수수료 메시지 결정
   * 5. 상태 저장 + 재고 복구 (트랜잭션)
   */
  async cancelReservation(id: number, dto: CancelReservationDto): Promise<CancelReservationResponseDto> {
    const reservation = await this.reservationRepository.findByIdWithItems(id);
    if (!reservation) throw new CustomException(ErrorCode.RESERVATION_NOT_FOUND);
    if (Number(reservation.userId) !== dto.userId) throw new CustomException(ErrorCode.FORBIDDEN);

    try {
      reservation.cancel();
    } catch {
      throw new CustomException(ErrorCode.ALREADY_CANCELLED);
    }

    const feeMessage = reservation.isWithinOneHourOfPickup()
      ? '취소 수수료 10%가 부과됩니다.'
      : '전액 환불됩니다.';

    const result = await this.dataSource.transaction(async (manager) => {
      await this.reservationRepository.save(reservation, manager);

      for (const item of reservation.items) {
        await this.inventoryRepository.restoreStock(item.inventoryId, item.qty, manager);
      }

      return CancelReservationResponseDto.from(reservation, feeMessage);
    });

    // 취소 성공 → CANCELLED 로 세션 상태 전이
    // AI가 취소 완료 메시지를 전달한 뒤 사용자가 새 예약을 시작할 수 있도록
    // 즉시 리셋하지 않고 CANCELLED 상태를 유지합니다.
    await this.redisHoldService.patchCurrentSession(String(dto.userId), {
      status: SessionStatus.CANCELLED,
    });
    this.logger.log(
      `[cancelReservation] session → CANCELLED userId=${dto.userId} reservationId=${id}`,
    );

    return result;
  }
}
