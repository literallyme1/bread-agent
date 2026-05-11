import { Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { randomUUID } from 'crypto';
import { ReservationRepository } from '../repository/reservation.repository';
import { InventoryRepository } from '../../inventory/repository/inventory.repository';
import { StoreRepository } from '../../store/repository/store.repository';
import { RedisHoldService, HoldData, HOLD_TTL_SECONDS } from '../../redis/redis.service';
import { SessionStatus } from '../../redis/session.schema';
import { CreateHoldDto } from '../dto/create-reservation.dto';
import { ConfirmHoldDto } from '../dto/confirm-hold.dto';
import { CancelReservationDto } from '../dto/cancel-reservation.dto';
import { HoldResponseDto, HoldItemResultDto } from '../dto/hold-response.dto';
import {
  ReservationResponseDto,
  CancelReservationResponseDto,
} from '../dto/reservation-response.dto';
import {
  ReservationListEntry,
  toReservationListEntry,
} from '../dto/reservation-list.dto';
import { Reservation, ReservationStatus } from '../entity/reservation.entity';
import { ReservationItem } from '../entity/reservation-item.entity';
import { CustomException } from '../../common/exception/custom.exception';
import { ErrorCode } from '../../common/exception/error-code.enum';
import { Store } from '../../store/entity/store.entity';

/**
 * pickupTime multi-step 검증.
 *   1) ISO 문자열 파싱 가능 여부
 *   2) 현재 이후 시간인지
 *   3) 현재 이후 시간인지
 */
function parsePickupTime(pickupTimeStr: string): Date {
  const pickupTime = new Date(pickupTimeStr);
  if (isNaN(pickupTime.getTime())) {
    throw new CustomException(ErrorCode.INVALID_PICKUP_TIME);
  }
  if (pickupTime <= new Date()) {
    throw new CustomException(ErrorCode.INVALID_PICKUP_TIME);
  }
  return pickupTime;
}

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

function validateStoreBusinessHours(pickupTime: Date, store: Store): void {
  const pickupMinutes = pickupTime.getHours() * 60 + pickupTime.getMinutes();
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
   * POST /v1/reservations/hold  —  All-or-Nothing 원자적 Hold
   *
   * [선 검증 단계]
   *   1. pickupTime multi-step 검증
   *   2. 사용자 / 매장 존재 확인 + 영업시간 검사
   *   3. 전체 아이템 재고를 순차 확인하여 resultItems / heldItems 빌드
   *
   * [후 점유 단계]  — 전체 재고 확보 성공(allHeld)인 경우에만 실행
   *   4. holdToken 생성 + Redis Hold 저장 (TTL 2분)
   *   5. 세션 → WAITING_FOR_CONFIRM + hold_token 기록
   *
   * [실패 처리]  — 단 하나라도 OUT_OF_STOCK이면 Redis Hold를 절대 생성하지 않음
   *   - 세션 → FAIL + last_error에 상세 실패 사유 기록
   *
   * 재고 차감은 confirm 단계에서만 수행 (동시성: 조건부 UPDATE).
   */
  async holdReservation(dto: CreateHoldDto): Promise<HoldResponseDto> {
    const pickupTime = parsePickupTime(dto.pickupTime);

    const user = await this.reservationRepository.findUserById(dto.userId);
    if (!user) throw new CustomException(ErrorCode.USER_NOT_FOUND);

    const store = await this.storeRepository.findById(dto.storeId);
    if (!store) throw new CustomException(ErrorCode.STORE_NOT_FOUND);
    validateStoreBusinessHours(pickupTime, store);

    // ── 선 검증: 전체 아이템 재고 확인 ─────────────────────────────────────
    const heldItems: HoldData['items'] = [];
    const resultItems: HoldItemResultDto[] = [];

    for (const reqItem of dto.items) {
      const inventory = await this.inventoryRepository.findByStoreAndBread(
        dto.storeId,
        reqItem.breadId,
      );
      const breadName = inventory?.bread?.name ?? `빵 #${reqItem.breadId}`;

      if (!inventory || inventory.available < reqItem.qty) {
        const remaining = inventory?.available ?? 0;
        resultItems.push({
          id: String(reqItem.breadId),
          name: breadName,
          requestedCount: reqItem.qty,
          heldCount: 0,
          status: 'OUT_OF_STOCK',
          reason: `재고 부족 (남은 수량: ${remaining}개)`,
        });
        continue;
      }

      heldItems.push({
        inventoryId: Number(inventory.id),
        breadId: reqItem.breadId,
        breadName,
        requestedQty: reqItem.qty,
        heldQty: reqItem.qty,
      });

      resultItems.push({
        id: String(reqItem.breadId),
        name: breadName,
        requestedCount: reqItem.qty,
        heldCount: reqItem.qty,
        status: 'SUCCESS',
      });
    }

    const allHeld = heldItems.length === dto.items.length;
    const userKey = String(dto.userId);

    if (allHeld) {
      // ── 후 점유: 모두 성공한 경우에만 Redis Hold 생성 ────────────────────
      const holdToken = randomUUID();
      const expiresAt = new Date(Date.now() + HOLD_TTL_SECONDS * 1000).toISOString();

      await this.redisHoldService.createHold(holdToken, {
        userId: dto.userId,
        storeId: dto.storeId,
        pickupTime: pickupTime.toISOString(),
        items: heldItems,
        expiresAt,
      });

      await this.redisHoldService.patchCurrentSession(userKey, {
        last_store_id: dto.storeId,
        last_store_name: store.name,
        hold_token: holdToken,
        status: SessionStatus.WAITING_FOR_CONFIRM,
        last_error: undefined,
      });

      this.logger.log(
        `[holdReservation] ALL held → WAITING_FOR_CONFIRM` +
          ` userId=${dto.userId} holdToken=${holdToken} items=${heldItems.length}`,
      );

      return { success: true, holdToken, items: resultItems };
    }

    // ── 실패: Redis Hold를 생성하지 않고 실패 정보를 세션에 기록 ─────────────
    const failedSummary = resultItems
      .filter((item) => item.status !== 'SUCCESS')
      .map((item) => `${item.name}: ${item.reason}`)
      .join(' / ');

    await this.redisHoldService.patchCurrentSession(userKey, {
      status: SessionStatus.FAIL,
      last_error: `일부 상품의 재고가 부족합니다 — ${failedSummary}`,
    });

    this.logger.warn(
      `[holdReservation] FAIL userId=${dto.userId}` +
        ` (held=${heldItems.length}/${dto.items.length}) ${failedSummary}`,
    );

    return { success: false, holdToken: null, items: resultItems };
  }

  /**
   * POST /v1/reservations/confirm
   *
   * 1. Redis에서 holdToken 조회 (없으면 만료/미존재)
   * 2. userId 일치 확인
   * 3. DB 트랜잭션:
   *    a. HELD 아이템 각각 조건부 UPDATE로 재고 차감
   *    b. Reservation 생성
   *    c. ReservationItem 생성
   * 4. Redis Hold 삭제
   * 5. ReservationResponseDto 반환
   */
  async confirmHold(dto: ConfirmHoldDto): Promise<ReservationResponseDto> {
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

    await this.redisHoldService.deleteHold(dto.holdToken);

    // 예약 확정 성공 → COMPLETED 로 세션 상태 전이 후 즉시 SEARCHING으로 초기화
    const confirmedUserKey = String(dto.userId);
    await this.redisHoldService.patchCurrentSession(confirmedUserKey, {
      status: SessionStatus.COMPLETED,
      hold_token: undefined,
    });
    this.logger.log(
      `[confirmHold] session updated → COMPLETED userId=${dto.userId} reservationId=${savedReservation.id}`,
    );

    await this.redisHoldService.resetCurrentSession(confirmedUserKey);
    this.logger.log(
      `User ${dto.userId}의 세션이 초기화되었습니다. 상태가 SEARCHING으로 리셋됩니다.`,
    );

    return ReservationResponseDto.from(savedReservation);
  }

  async getReservation(id: number): Promise<ReservationResponseDto> {
    const reservation = await this.reservationRepository.findByIdWithItems(id);
    if (!reservation) throw new CustomException(ErrorCode.RESERVATION_NOT_FOUND);
    return ReservationResponseDto.from(reservation);
  }

  /**
   * GET /v1/reservations
   *
   * userId + status 필터로 예약 목록을 조회합니다.
   * API 친화적 소문자 status('confirmed' | 'cancelled')를 DB enum으로 변환하여 조회합니다.
   */
  async getReservationList(
    userId: number,
    status: 'confirmed' | 'cancelled',
  ): Promise<ReservationListEntry[]> {
    const dbStatus =
      status === 'confirmed' ? ReservationStatus.CONFIRMED : ReservationStatus.CANCELLED;

    const reservations = await this.reservationRepository.findByUserIdAndStatus(userId, dbStatus);
    return reservations.map(toReservationListEntry);
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

    // 취소 성공 → CANCELLED 로 세션 상태 전이 후 즉시 SEARCHING으로 초기화
    const userKey = String(dto.userId);
    await this.redisHoldService.patchCurrentSession(userKey, {
      status: SessionStatus.CANCELLED,
      hold_token: undefined,
    });
    this.logger.log(
      `[cancelReservation] session updated → CANCELLED userId=${dto.userId} reservationId=${id}`,
    );

    await this.redisHoldService.resetCurrentSession(userKey);
    this.logger.log(
      `User ${dto.userId}의 세션이 초기화되었습니다. 상태가 SEARCHING으로 리셋됩니다.`,
    );

    return result;
  }
}
