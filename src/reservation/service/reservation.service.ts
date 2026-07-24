import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { randomUUID } from 'crypto';
import { ReservationRepository } from '../repository/reservation.repository';
import { InventoryRepository } from '../../inventory/repository/inventory.repository';
import { StoreRepository } from '../../store/repository/store.repository';
import {
  RedisHoldService,
  HoldData,
  HOLD_TTL_SECONDS,
} from '../../redis/redis.service';
import { SessionStatus } from '../../redis/session.schema';
import { ConfirmHoldDto } from '../dto/confirm-hold.dto';
import { CancelReservationDto } from '../dto/cancel-reservation.dto';
import { HoldResponseDto, HoldItemResultDto } from '../dto/hold-response.dto';
import {
  ConfirmReservationResponseDto,
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
import {
  parsePickupInstantFromClientString,
  isPickupInstantBeforeGraceThreshold,
} from '../../common/utils/kst-pickup-time.util';

const KST_IANA = 'Asia/Seoul';

const HOLD_EXPIRED_SESSION_MESSAGE =
  '임시 예약 시간이 만료되었습니다. 다시 한번 예약 정보를 확인하고 재시도해주세요.';

/** HH:mm 형식의 영업 시각을 분 단위로 변환한다. */
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

/** 특정 시간대의 시각을 분 단위 벽시각으로 변환한다. */
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

/** 픽업 시각이 매장의 서울 영업시간 안에 있는지 검증한다. */
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

  /** Redis 예약 컨텍스트를 검증하고 2분 Hold Token을 생성한다. */
  async holdReservation(userId: string): Promise<HoldResponseDto> {
    const userKey = userId.trim();
    const numericUserId = Number(userKey);
    if (
      !userKey ||
      Number.isNaN(numericUserId) ||
      !Number.isInteger(numericUserId)
    ) {
      throw new BadRequestException('유효한 userId가 필요합니다.');
    }

    const session = await this.redisHoldService.getSession(userKey);
    const reservationContext = session?.current_session;

    if (!reservationContext) {
      throw new BadRequestException(
        '예약 세션이 없습니다. 먼저 patchSession으로 매장·메뉴·픽업 시간을 저장해 주세요.',
      );
    }

    const storeId =
      reservationContext.last_store_id !== undefined &&
      reservationContext.last_store_id !== null
        ? Number(reservationContext.last_store_id)
        : undefined;
    const pickupRaw = reservationContext.pickup_time;
    const items = reservationContext.selected_items ?? [];

    if (
      storeId === undefined ||
      Number.isNaN(storeId) ||
      items.length === 0 ||
      !pickupRaw
    ) {
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

    const validatedHoldItems: HoldData['items'] = [];
    const resultItems: HoldItemResultDto[] = [];

    for (const line of items) {
      const breadId = Number(line.id);
      const qty = Number(line.count);
      if (
        !Number.isInteger(breadId) ||
        breadId < 1 ||
        !Number.isInteger(qty) ||
        qty < 1
      ) {
        throw new BadRequestException(
          `selected_items 항목이 올바르지 않습니다: id=${line.id}, count=${line.count}`,
        );
      }

      const inventory = await this.inventoryRepository.findByStoreAndBread(
        storeId,
        breadId,
      );
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

      validatedHoldItems.push({
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

    const allItemsAvailable = validatedHoldItems.length === items.length;

    if (allItemsAvailable) {
      const holdToken = randomUUID();
      const expiresAt = new Date(
        Date.now() + HOLD_TTL_SECONDS * 1000,
      ).toISOString();

      await this.redisHoldService.createHold(holdToken, {
        userId: numericUserId,
        storeId,
        pickupTime: pickupTime.toISOString(),
        items: validatedHoldItems,
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
          ` userId=${userKey} holdToken=${holdToken} items=${validatedHoldItems.length}`,
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
        ` (held=${validatedHoldItems.length}/${items.length}) ${failedSummary}`,
    );

    return { success: false, holdToken: null, items: resultItems };
  }

  /** 만료된 Hold를 제거하고 예약 요약 확인 단계로 복구한다. */
  private async rejectExpiredHoldAndRestoreSummary(
    userKey: string,
    holdTokenForLog: string,
  ): Promise<never> {
    await this.redisHoldService.patchCurrentSession(userKey, {
      status: SessionStatus.READY_FOR_SUMMARY,
      last_error: HOLD_EXPIRED_SESSION_MESSAGE,
      hold_token: undefined,
    });
    this.logger.warn(
      `[confirmHold] hold missing/expired → READY_FOR_SUMMARY userId=${userKey} holdToken=${holdTokenForLog}`,
    );
    throw new CustomException(ErrorCode.HOLD_EXPIRED, {
      status: SessionStatus.READY_FOR_SUMMARY,
      last_error: HOLD_EXPIRED_SESSION_MESSAGE,
    });
  }

  /** Hold를 재검증하고 원자적 재고 차감과 예약 생성을 확정한다. */
  async confirmHold(
    dto: ConfirmHoldDto,
  ): Promise<ConfirmReservationResponseDto> {
    const userKey = String(dto.userId);
    const holdTokenFromClient = dto.holdToken?.trim();
    if (!holdTokenFromClient) {
      throw new BadRequestException('holdToken이 필요합니다.');
    }

    const session = await this.redisHoldService.getSession(userKey);
    const reservationContext = session?.current_session;

    if (!reservationContext) {
      throw new BadRequestException(
        '예약 세션이 없습니다. 먼저 patchSession으로 매장·메뉴·픽업 시간을 저장해 주세요.',
      );
    }

    const tokenFromSession =
      typeof reservationContext.hold_token === 'string'
        ? reservationContext.hold_token.trim()
        : '';
    if (!tokenFromSession) {
      await this.rejectExpiredHoldAndRestoreSummary(
        userKey,
        holdTokenFromClient,
      );
      throw new Error('unreachable');
    }

    if (tokenFromSession !== holdTokenFromClient) {
      throw new BadRequestException(
        '세션의 hold_token과 요청 holdToken이 일치하지 않습니다.',
      );
    }

    const holdData = await this.redisHoldService.getHold(holdTokenFromClient);

    if (!holdData) {
      await this.rejectExpiredHoldAndRestoreSummary(
        userKey,
        holdTokenFromClient,
      );
      throw new Error('unreachable');
    }

    if (holdData.userId !== dto.userId)
      throw new CustomException(ErrorCode.HOLD_USER_MISMATCH);

    const store = await this.storeRepository.findById(holdData.storeId);
    if (!store) throw new CustomException(ErrorCode.STORE_NOT_FOUND);

    const pickupTime = new Date(holdData.pickupTime);

    const savedReservation = await this.dataSource.transaction(
      async (manager) => {
        for (const item of holdData.items) {
          await this.inventoryRepository.decreaseAvailableStockAtomically(
            item.inventoryId,
            item.heldQty,
            manager,
          );
        }

        const reservation = manager.getRepository(Reservation).create({
          userId: holdData.userId,
          status: ReservationStatus.CONFIRMED,
          pickupTime,
        });
        const saved = await this.reservationRepository.save(
          reservation,
          manager,
        );

        const savedItems: ReservationItem[] = [];
        for (const item of holdData.items) {
          const resItem = manager.getRepository(ReservationItem).create({
            reservationId: saved.id,
            inventoryId: item.inventoryId,
            qty: item.heldQty,
          });
          const savedItem = await this.reservationRepository.saveItem(
            resItem,
            manager,
          );
          savedItems.push(savedItem);
        }

        saved.items = savedItems;
        return saved;
      },
    );

    await this.redisHoldService.deleteHold(holdTokenFromClient);
    await this.redisHoldService.deleteSession(String(dto.userId));

    this.logger.log(
      `[confirmHold] confirmed userId=${dto.userId} reservationId=${savedReservation.id}` +
        ` store="${store.name}" — session deleted`,
    );

    return ConfirmReservationResponseDto.from(
      savedReservation,
      holdData,
      store,
    );
  }

  /** 예약 ID로 예약과 예약 항목을 조회한다. */
  async getReservation(id: number): Promise<ReservationResponseDto> {
    const reservation = await this.reservationRepository.findByIdWithItems(id);
    if (!reservation)
      throw new CustomException(ErrorCode.RESERVATION_NOT_FOUND);
    return ReservationResponseDto.from(reservation);
  }

  /** 취소 가능한 미래 예약을 조회하고 취소 확인 상태로 전이한다. */
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

  /** 사용자 권한을 검증하고 예약 취소와 재고 복구를 원자적으로 처리한다. */
  async cancelReservation(
    id: number,
    dto: CancelReservationDto,
  ): Promise<CancelReservationResponseDto> {
    const reservation = await this.reservationRepository.findByIdWithItems(id);
    if (!reservation)
      throw new CustomException(ErrorCode.RESERVATION_NOT_FOUND);
    if (Number(reservation.userId) !== dto.userId)
      throw new CustomException(ErrorCode.FORBIDDEN);

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
        await this.inventoryRepository.restoreCancelledStock(
          item.inventoryId,
          item.qty,
          manager,
        );
      }

      return CancelReservationResponseDto.from(reservation, feeMessage);
    });

    await this.redisHoldService.patchCurrentSession(String(dto.userId), {
      status: SessionStatus.CANCELLED,
    });
    this.logger.log(
      `[cancelReservation] session → CANCELLED userId=${dto.userId} reservationId=${id}`,
    );

    return result;
  }
}
