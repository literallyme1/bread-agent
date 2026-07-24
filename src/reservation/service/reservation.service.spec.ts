import { BadRequestException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { DataSource, EntityManager } from 'typeorm';
import { ReservationService } from './reservation.service';
import { ReservationRepository } from '../repository/reservation.repository';
import { InventoryRepository } from '../../inventory/repository/inventory.repository';
import { StoreRepository } from '../../store/repository/store.repository';
import { RedisHoldService, HOLD_TTL_SECONDS } from '../../redis/redis.service';
import { ConfirmHoldDto } from '../dto/confirm-hold.dto';
import { Reservation, ReservationStatus } from '../entity/reservation.entity';
import { ReservationItem } from '../entity/reservation-item.entity';
import { Inventory } from '../../inventory/entity/inventory.entity';
import { Bread } from '../../bread/entity/bread.entity';
import { User } from '../../user/entity/user.entity';
import { Store } from '../../store/entity/store.entity';
import { CustomException } from '../../common/exception/custom.exception';
import { ErrorCode } from '../../common/exception/error-code.enum';

/** KST 영업일 안의 미래 ISO (내일 12:00 UTC 근처 등 단순 고정) */
function futurePickupIso(): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + 1);
  d.setUTCHours(12, 0, 0, 0);
  return d.toISOString();
}

function makeInventory(
  overrides: Partial<Inventory> & { breadName?: string } = {},
): Inventory {
  const inv = new Inventory();
  inv.id = overrides.id ?? 10;
  inv.storeId = overrides.storeId ?? 1;
  inv.breadId = overrides.breadId ?? 1;
  inv.available = overrides.available ?? 5;
  inv.price = overrides.price ?? 3000;
  const bread = new Bread();
  bread.id = inv.breadId;
  bread.name = overrides.breadName ?? '소금빵';
  inv.bread = bread;
  return inv;
}

function baseSession(overrides: Record<string, unknown> = {}) {
  return {
    current_session: {
      last_store_id: 1,
      last_store_name: '테스트매장',
      pickup_time: futurePickupIso(),
      selected_items: [{ id: 1, name: '소금빵', count: 2 }],
      status: 'READY_FOR_SUMMARY',
      ...overrides,
    },
  };
}

describe('ReservationService', () => {
  let service: ReservationService;
  let dataSource: jest.Mocked<DataSource>;
  let reservationRepository: jest.Mocked<ReservationRepository>;
  let inventoryRepository: jest.Mocked<InventoryRepository>;
  let storeRepository: jest.Mocked<StoreRepository>;
  let redisHoldService: jest.Mocked<RedisHoldService>;
  let mockManager: Partial<EntityManager>;

  beforeEach(async () => {
    mockManager = {
      getRepository: jest.fn().mockReturnValue({
        create: jest.fn(),
        save: jest.fn(),
      }),
    };

    dataSource = {
      transaction: jest
        .fn()
        .mockImplementation(async (cb: (m: EntityManager) => Promise<any>) =>
          cb(mockManager as EntityManager),
        ),
    } as any;

    reservationRepository = {
      findUserById: jest.fn(),
      findByIdWithItems: jest.fn(),
      save: jest.fn(),
      saveItem: jest.fn(),
    } as any;

    inventoryRepository = {
      findByStoreAndBread: jest.fn(),
      decreaseAvailableStockAtomically: jest.fn(),
      restoreCancelledStock: jest.fn(),
    } as any;

    storeRepository = {
      findById: jest.fn(),
    } as any;

    redisHoldService = {
      createHold: jest.fn(),
      getHold: jest.fn(),
      deleteHold: jest.fn(),
      getTtl: jest.fn(),
      getSession: jest.fn(),
      patchCurrentSession: jest.fn(),
      deleteSession: jest.fn(),
    } as any;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ReservationService,
        { provide: DataSource, useValue: dataSource },
        { provide: ReservationRepository, useValue: reservationRepository },
        { provide: InventoryRepository, useValue: inventoryRepository },
        { provide: StoreRepository, useValue: storeRepository },
        { provide: RedisHoldService, useValue: redisHoldService },
      ],
    }).compile();

    service = module.get<ReservationService>(ReservationService);
  });

  describe('holdReservation', () => {
    beforeEach(() => {
      redisHoldService.getSession.mockResolvedValue(baseSession() as any);
      reservationRepository.findUserById.mockResolvedValue({ id: 1 } as User);
      storeRepository.findById.mockResolvedValue({
        id: 1,
        name: '테스트',
        openTime: '09:00:00',
        closeTime: '22:00:00',
      } as Store);
      redisHoldService.createHold.mockResolvedValue(undefined);
      redisHoldService.patchCurrentSession.mockResolvedValue(undefined);
    });

    it('여러 빵 hold 성공 — 모두 재고 있는 경우', async () => {
      redisHoldService.getSession.mockResolvedValue(
        baseSession({
          selected_items: [
            { id: 1, name: '소금빵', count: 2 },
            { id: 2, name: '고구마빵', count: 1 },
          ],
        }) as any,
      );
      inventoryRepository.findByStoreAndBread
        .mockResolvedValueOnce(
          makeInventory({
            id: 10,
            breadId: 1,
            available: 5,
            breadName: '소금빵',
          }),
        )
        .mockResolvedValueOnce(
          makeInventory({
            id: 20,
            breadId: 2,
            available: 3,
            breadName: '고구마빵',
          }),
        );

      const result = await service.holdReservation('1');

      expect(result.holdToken).toBeDefined();
      expect(result.items).toHaveLength(2);
      expect(result.items[0].status).toBe('SUCCESS');
      expect(result.items[0].heldCount).toBe(2);
      expect(result.items[1].status).toBe('SUCCESS');
      expect(result.items[1].heldCount).toBe(1);
      expect(redisHoldService.createHold).toHaveBeenCalledTimes(1);
    });

    it('일부 품절 — 재고 없는 빵은 OUT_OF_STOCK', async () => {
      redisHoldService.getSession.mockResolvedValue(
        baseSession({
          selected_items: [
            { id: 1, name: '소금빵', count: 2 },
            { id: 2, name: '고구마빵', count: 3 },
          ],
        }) as any,
      );
      inventoryRepository.findByStoreAndBread
        .mockResolvedValueOnce(
          makeInventory({ available: 5, breadName: '소금빵' }),
        )
        .mockResolvedValueOnce(
          makeInventory({
            id: 20,
            breadId: 2,
            available: 1,
            breadName: '고구마빵',
          }),
        );

      const result = await service.holdReservation('1');

      const ok = result.items.find((i) => i.status === 'SUCCESS');
      const oos = result.items.find((i) => i.status === 'OUT_OF_STOCK');
      expect(ok).toBeDefined();
      expect(oos).toBeDefined();
      expect(oos!.heldCount).toBe(0);
      expect(result.success).toBe(false);
      expect(redisHoldService.createHold).not.toHaveBeenCalled();
    });

    it('inventory 없으면 해당 아이템 OUT_OF_STOCK', async () => {
      inventoryRepository.findByStoreAndBread.mockResolvedValue(null);

      const result = await service.holdReservation('1');
      expect(result.items[0].status).toBe('OUT_OF_STOCK');
      expect(result.success).toBe(false);
    });

    it('사용자 없으면 USER_NOT_FOUND', async () => {
      reservationRepository.findUserById.mockResolvedValue(null);
      await expect(service.holdReservation('1')).rejects.toThrow(
        new CustomException(ErrorCode.USER_NOT_FOUND),
      );
    });

    it('매장 없으면 STORE_NOT_FOUND', async () => {
      storeRepository.findById.mockResolvedValue(null);
      await expect(service.holdReservation('1')).rejects.toThrow(
        new CustomException(ErrorCode.STORE_NOT_FOUND),
      );
    });

    it('세션 없으면 400', async () => {
      redisHoldService.getSession.mockResolvedValue(null);
      await expect(service.holdReservation('1')).rejects.toThrow(
        BadRequestException,
      );
    });

    it('필수 필드 누락 시 400', async () => {
      redisHoldService.getSession.mockResolvedValue(
        baseSession({
          last_store_id: undefined,
          pickup_time: futurePickupIso(),
        }) as any,
      );
      await expect(service.holdReservation('1')).rejects.toThrow(
        BadRequestException,
      );
    });

    it('selected_items 비면 400', async () => {
      redisHoldService.getSession.mockResolvedValue(
        baseSession({ selected_items: [] }) as any,
      );
      await expect(service.holdReservation('1')).rejects.toThrow(
        BadRequestException,
      );
    });

    it('과거 픽업(유예 5초) → 예약 가능한 시간이 지났습니다', async () => {
      redisHoldService.getSession.mockResolvedValue(
        baseSession({
          pickup_time: new Date(Date.now() - 60_000).toISOString(),
        }) as any,
      );
      await expect(service.holdReservation('1')).rejects.toThrow(
        '예약 가능한 시간이 지났습니다',
      );
    });

    it('잘못된 픽업 형식 → 400', async () => {
      redisHoldService.getSession.mockResolvedValue(
        baseSession({ pickup_time: 'not-a-date' }) as any,
      );
      await expect(service.holdReservation('1')).rejects.toThrow(
        BadRequestException,
      );
    });

    it('pickup_time에 Z 없이 KST 벽시각만 있어도 hold 성공', async () => {
      redisHoldService.getSession.mockResolvedValue(
        baseSession({ pickup_time: '2060-06-15T14:00:00' }) as any,
      );
      inventoryRepository.findByStoreAndBread.mockResolvedValue(
        makeInventory({ available: 5 }),
      );

      const result = await service.holdReservation('1');
      expect(result.success).toBe(true);
      expect(redisHoldService.createHold).toHaveBeenCalled();
    });

    it('영업시간 외(서울 벽시계) → STORE_CLOSED', async () => {
      // 2060-06-01 23:30 UTC = 2060-06-02 08:30 KST → 오픈(09:00) 이전
      redisHoldService.getSession.mockResolvedValue(
        baseSession({ pickup_time: '2060-06-01T23:30:00.000Z' }) as any,
      );
      inventoryRepository.findByStoreAndBread.mockResolvedValue(
        makeInventory({ available: 5 }),
      );

      await expect(service.holdReservation('1')).rejects.toThrow(
        new CustomException(ErrorCode.STORE_CLOSED),
      );
    });
  });

  describe('confirmHold', () => {
    const holdToken = 'test-token-uuid';
    const confirmDto: ConfirmHoldDto = { userId: 1, holdToken };

    const mockHoldData = {
      userId: 1,
      storeId: 1,
      pickupTime: futurePickupIso(),
      items: [
        {
          inventoryId: 10,
          breadId: 1,
          breadName: '소금빵',
          requestedQty: 2,
          heldQty: 2,
        },
        {
          inventoryId: 20,
          breadId: 2,
          breadName: '고구마빵',
          requestedQty: 1,
          heldQty: 1,
        },
      ],
      expiresAt: new Date(Date.now() + HOLD_TTL_SECONDS * 1000).toISOString(),
    };

    beforeEach(() => {
      redisHoldService.getSession.mockResolvedValue(
        baseSession({
          status: 'WAITING_FOR_CONFIRM',
          hold_token: holdToken,
        }) as any,
      );
      redisHoldService.patchCurrentSession.mockResolvedValue(undefined);
      redisHoldService.deleteSession.mockResolvedValue(undefined);
    });

    it('hold 확정 후 inventory 감소 및 Reservation 생성', async () => {
      redisHoldService.getHold.mockResolvedValue(mockHoldData);
      inventoryRepository.decreaseAvailableStockAtomically.mockResolvedValue(
        undefined,
      );

      const mockReservation = Object.assign(new Reservation(), {
        id: 99,
        userId: 1,
        storeId: 1,
        status: ReservationStatus.CONFIRMED,
        pickupTime: new Date(mockHoldData.pickupTime),
        createdAt: new Date(),
      });

      reservationRepository.save.mockResolvedValue(mockReservation);
      reservationRepository.saveItem.mockResolvedValue({} as ReservationItem);
      storeRepository.findById.mockResolvedValue({
        id: 1,
        name: '하레하레',
        station: '강남역',
        address: '주소',
      } as Store);

      redisHoldService.deleteHold.mockResolvedValue(undefined);

      const result = await service.confirmHold(confirmDto);

      expect(result.reservationId).toBe(99);
      expect(redisHoldService.deleteHold).toHaveBeenCalledWith(holdToken);
      expect(redisHoldService.deleteSession).toHaveBeenCalledWith('1');
    });

    it('이미 만료된 holdToken → HOLD_EXPIRED + 세션 강등', async () => {
      redisHoldService.getHold.mockResolvedValue(null);
      await expect(service.confirmHold(confirmDto)).rejects.toMatchObject({
        errorCode: ErrorCode.HOLD_EXPIRED,
        errorPayload: {
          status: 'READY_FOR_SUMMARY',
          last_error:
            '임시 예약 시간이 만료되었습니다. 다시 한번 예약 정보를 확인하고 재시도해주세요.',
        },
      });
      expect(redisHoldService.patchCurrentSession).toHaveBeenCalledWith('1', {
        status: 'READY_FOR_SUMMARY',
        last_error:
          '임시 예약 시간이 만료되었습니다. 다시 한번 예약 정보를 확인하고 재시도해주세요.',
        hold_token: undefined,
      });
    });

    it('세션에 hold_token 없음 → HOLD_EXPIRED + 세션 강등', async () => {
      redisHoldService.getSession.mockResolvedValue(
        baseSession({
          status: 'WAITING_FOR_CONFIRM',
          hold_token: undefined,
        }) as any,
      );
      redisHoldService.getHold.mockResolvedValue(null);
      await expect(service.confirmHold(confirmDto)).rejects.toMatchObject({
        errorCode: ErrorCode.HOLD_EXPIRED,
      });
      expect(redisHoldService.patchCurrentSession).toHaveBeenCalledWith(
        '1',
        expect.objectContaining({
          status: 'READY_FOR_SUMMARY',
          hold_token: undefined,
        }),
      );
    });

    it('userId 불일치 → HOLD_USER_MISMATCH', async () => {
      redisHoldService.getHold.mockResolvedValue({
        ...mockHoldData,
        userId: 99,
      });
      await expect(
        service.confirmHold({ userId: 1, holdToken }),
      ).rejects.toThrow(new CustomException(ErrorCode.HOLD_USER_MISMATCH));
    });
  });
});
