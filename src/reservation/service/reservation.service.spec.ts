import { Test, TestingModule } from '@nestjs/testing';
import { DataSource, EntityManager } from 'typeorm';
import { ReservationService } from './reservation.service';
import { ReservationRepository } from '../repository/reservation.repository';
import { InventoryRepository } from '../../inventory/repository/inventory.repository';
import { StoreRepository } from '../../store/repository/store.repository';
import { RedisHoldService, HOLD_TTL_SECONDS } from '../../redis/redis.service';
import { CreateHoldDto } from '../dto/create-reservation.dto';
import { ConfirmHoldDto } from '../dto/confirm-hold.dto';
import { CancelReservationDto } from '../dto/cancel-reservation.dto';
import { Reservation, ReservationStatus } from '../entity/reservation.entity';
import { ReservationItem } from '../entity/reservation-item.entity';
import { Inventory } from '../../inventory/entity/inventory.entity';
import { Bread } from '../../bread/entity/bread.entity';
import { User } from '../../user/entity/user.entity';
import { Store } from '../../store/entity/store.entity';
import { CustomException } from '../../common/exception/custom.exception';
import { ErrorCode } from '../../common/exception/error-code.enum';

/**
 * 기본 매장 영업시간(09:00–22:00) 안의 미래 시각을 반환
 */
function futureBusinessHour(hoursFromNow = 2): string {
  const d = new Date(Date.now() + hoursFromNow * 3600 * 1000);
  if (d.getHours() < 9 || d.getHours() >= 22) {
    const fixed = new Date();
    fixed.setDate(fixed.getDate() + 1);
    fixed.setHours(12, 0, 0, 0);
    return fixed.toISOString();
  }
  return d.toISOString();
}

function makeInventory(overrides: Partial<Inventory> & { breadName?: string } = {}): Inventory {
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
      transaction: jest.fn().mockImplementation(async (cb: (m: EntityManager) => Promise<any>) =>
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
      decreaseStock: jest.fn(),
      restoreStock: jest.fn(),
    } as any;

    storeRepository = {
      findById: jest.fn(),
    } as any;

    redisHoldService = {
      createHold: jest.fn(),
      getHold: jest.fn(),
      deleteHold: jest.fn(),
      getTtl: jest.fn(),
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

  // ─── holdReservation ─────────────────────────────────────────────────────────

  describe('holdReservation', () => {
    const buildDto = (overrides: Partial<CreateHoldDto> = {}): CreateHoldDto => ({
      userId: 1,
      storeId: 1,
      pickupTime: futureBusinessHour(),
      items: [{ breadId: 1, qty: 2 }],
      ...overrides,
    });

    beforeEach(() => {
      reservationRepository.findUserById.mockResolvedValue({ id: 1 } as User);
      storeRepository.findById.mockResolvedValue({
        id: 1,
        openTime: '09:00:00',
        closeTime: '22:00:00',
      } as Store);
      redisHoldService.createHold.mockResolvedValue(undefined);
    });

    it('여러 빵 hold 성공 — 모두 재고 있는 경우', async () => {
      inventoryRepository.findByStoreAndBread
        .mockResolvedValueOnce(makeInventory({ id: 10, breadId: 1, available: 5, breadName: '소금빵' }))
        .mockResolvedValueOnce(makeInventory({ id: 20, breadId: 2, available: 3, breadName: '고구마빵' }));

      const dto = buildDto({ items: [{ breadId: 1, qty: 2 }, { breadId: 2, qty: 1 }] });
      const result = await service.holdReservation(dto);

      expect(result.holdToken).toBeDefined();
      expect(result.items).toHaveLength(2);
      expect(result.items[0].status).toBe('HELD');
      expect(result.items[0].heldQty).toBe(2);
      expect(result.items[1].status).toBe('HELD');
      expect(result.items[1].heldQty).toBe(1);
      expect(redisHoldService.createHold).toHaveBeenCalledTimes(1);
    });

    it('일부 품절 상태 검증 — 재고 없는 빵은 OUT_OF_STOCK', async () => {
      inventoryRepository.findByStoreAndBread
        .mockResolvedValueOnce(makeInventory({ available: 5, breadName: '소금빵' }))
        .mockResolvedValueOnce(makeInventory({ id: 20, breadId: 2, available: 1, breadName: '고구마빵' }));

      const dto = buildDto({ items: [{ breadId: 1, qty: 2 }, { breadId: 2, qty: 3 }] });
      const result = await service.holdReservation(dto);

      const held = result.items.find((i) => i.status === 'HELD');
      const oos = result.items.find((i) => i.status === 'OUT_OF_STOCK');

      expect(held).toBeDefined();
      expect(oos).toBeDefined();
      expect(oos!.heldQty).toBe(0);
    });

    it('inventory 없으면 해당 아이템 OUT_OF_STOCK으로 처리', async () => {
      inventoryRepository.findByStoreAndBread.mockResolvedValue(null);

      const result = await service.holdReservation(buildDto());

      expect(result.items[0].status).toBe('OUT_OF_STOCK');
    });

    it('사용자 없으면 USER_NOT_FOUND 예외', async () => {
      reservationRepository.findUserById.mockResolvedValue(null);

      await expect(service.holdReservation(buildDto())).rejects.toThrow(
        new CustomException(ErrorCode.USER_NOT_FOUND),
      );
    });

    it('매장 없으면 STORE_NOT_FOUND 예외', async () => {
      storeRepository.findById.mockResolvedValue(null);

      await expect(service.holdReservation(buildDto())).rejects.toThrow(
        new CustomException(ErrorCode.STORE_NOT_FOUND),
      );
    });
  });

  // ─── holdReservation — pickupTime validation ──────────────────────────────────

  describe('holdReservation — pickupTime validation', () => {
    const base: CreateHoldDto = {
      userId: 1,
      storeId: 1,
      pickupTime: futureBusinessHour(),
      items: [{ breadId: 1, qty: 1 }],
    };

    beforeEach(() => {
      reservationRepository.findUserById.mockResolvedValue({ id: 1 } as User);
      storeRepository.findById.mockResolvedValue({
        id: 1,
        openTime: '09:00:00',
        closeTime: '22:00:00',
      } as Store);
    });

    it('영업시간 내 예약 성공', async () => {
      inventoryRepository.findByStoreAndBread.mockResolvedValue(
        makeInventory({ available: 5, breadName: '소금빵' }),
      );
      redisHoldService.createHold.mockResolvedValue(undefined);

      const d = new Date();
      d.setDate(d.getDate() + 1);
      d.setHours(10, 0, 0, 0);
      const dto = { ...base, pickupTime: d.toISOString() };

      const result = await service.holdReservation(dto);
      expect(result.items[0].status).toBe('HELD');
    });

    it('과거 시간 → INVALID_PICKUP_TIME 예외', async () => {
      const dto = { ...base, pickupTime: new Date(Date.now() - 1000).toISOString() };
      await expect(service.holdReservation(dto)).rejects.toThrow(
        new CustomException(ErrorCode.INVALID_PICKUP_TIME),
      );
    });

    it('잘못된 형식 → INVALID_PICKUP_TIME 예외', async () => {
      const dto = { ...base, pickupTime: 'not-a-date' };
      await expect(service.holdReservation(dto)).rejects.toThrow(
        new CustomException(ErrorCode.INVALID_PICKUP_TIME),
      );
    });

    it('오픈 이전 시간 예약 실패', async () => {
      const d = new Date();
      d.setDate(d.getDate() + 1);
      d.setHours(8, 0, 0, 0);
      const dto = { ...base, pickupTime: d.toISOString() };

      await expect(service.holdReservation(dto)).rejects.toThrow(
        new CustomException(ErrorCode.STORE_CLOSED),
      );
    });

    it('마감 이후 시간 예약 실패', async () => {
      const d = new Date();
      d.setDate(d.getDate() + 1);
      d.setHours(23, 0, 0, 0);
      const dto = { ...base, pickupTime: d.toISOString() };

      await expect(service.holdReservation(dto)).rejects.toThrow(
        new CustomException(ErrorCode.STORE_CLOSED),
      );
    });
  });

  // ─── confirmHold ──────────────────────────────────────────────────────────────

  describe('confirmHold', () => {
    const holdToken = 'test-token-uuid';
    const confirmDto: ConfirmHoldDto = { userId: 1, holdToken };

    const mockHoldData = {
      userId: 1,
      storeId: 1,
      pickupTime: futureBusinessHour(),
      items: [
        { inventoryId: 10, breadId: 1, breadName: '소금빵', requestedQty: 2, heldQty: 2 },
        { inventoryId: 20, breadId: 2, breadName: '고구마빵', requestedQty: 1, heldQty: 1 },
      ],
      expiresAt: new Date(Date.now() + HOLD_TTL_SECONDS * 1000).toISOString(),
    };

    it('hold 확정 후 inventory 감소 및 Reservation 생성', async () => {
      redisHoldService.getHold.mockResolvedValue(mockHoldData);
      inventoryRepository.decreaseStock.mockResolvedValue(undefined);

      const mockReservation = Object.assign(new Reservation(), {
        id: 1,
        userId: 1,
        status: ReservationStatus.CONFIRMED,
        pickupTime: new Date(mockHoldData.pickupTime),
        createdAt: new Date(),
        items: [],
      });
      const mockItem1 = Object.assign(new ReservationItem(), { id: 1, inventoryId: 10, qty: 2 });
      const mockItem2 = Object.assign(new ReservationItem(), { id: 2, inventoryId: 20, qty: 1 });

      const entityRepo = {
        create: jest.fn()
          .mockReturnValueOnce(mockReservation)
          .mockReturnValueOnce(mockItem1)
          .mockReturnValueOnce(mockItem2),
      };
      (mockManager.getRepository as jest.Mock).mockReturnValue(entityRepo);

      reservationRepository.save.mockResolvedValue(mockReservation);
      reservationRepository.saveItem
        .mockResolvedValueOnce(mockItem1)
        .mockResolvedValueOnce(mockItem2);
      redisHoldService.deleteHold.mockResolvedValue(undefined);

      const result = await service.confirmHold(confirmDto);

      // inventory 차감: 각 held 아이템별 1회
      expect(inventoryRepository.decreaseStock).toHaveBeenCalledTimes(2);
      expect(inventoryRepository.decreaseStock).toHaveBeenCalledWith(10, 2, mockManager);
      expect(inventoryRepository.decreaseStock).toHaveBeenCalledWith(20, 1, mockManager);

      expect(redisHoldService.deleteHold).toHaveBeenCalledWith(holdToken);
      expect(result.status).toBe(ReservationStatus.CONFIRMED);
    });

    it('이미 만료된 holdToken → HOLD_NOT_FOUND 예외 (Redis TTL 만료 시뮬레이션)', async () => {
      redisHoldService.getHold.mockResolvedValue(null); // TTL 만료 = Redis에서 null 반환

      await expect(service.confirmHold(confirmDto)).rejects.toThrow(
        new CustomException(ErrorCode.HOLD_NOT_FOUND),
      );
      expect(inventoryRepository.decreaseStock).not.toHaveBeenCalled();
    });

    it('userId 불일치 → HOLD_USER_MISMATCH 예외', async () => {
      redisHoldService.getHold.mockResolvedValue({ ...mockHoldData, userId: 99 });

      await expect(service.confirmHold({ userId: 1, holdToken })).rejects.toThrow(
        new CustomException(ErrorCode.HOLD_USER_MISMATCH),
      );
    });

    it('재고 부족 시 OUT_OF_STOCK 예외 전파 (confirm 단계 조건부 UPDATE 실패)', async () => {
      redisHoldService.getHold.mockResolvedValue(mockHoldData);
      inventoryRepository.decreaseStock.mockRejectedValue(
        new CustomException(ErrorCode.OUT_OF_STOCK),
      );
      (mockManager.getRepository as jest.Mock).mockReturnValue({ create: jest.fn() });

      await expect(service.confirmHold(confirmDto)).rejects.toThrow(
        new CustomException(ErrorCode.OUT_OF_STOCK),
      );
    });
  });

  // ─── getReservation ───────────────────────────────────────────────────────────

  describe('getReservation', () => {
    it('존재하는 예약 조회 시 ReservationResponseDto 반환', async () => {
      const mockReservation = Object.assign(new Reservation(), {
        id: 1,
        userId: 1,
        status: ReservationStatus.CONFIRMED,
        pickupTime: new Date(),
        createdAt: new Date(),
        items: [],
      });
      reservationRepository.findByIdWithItems.mockResolvedValue(mockReservation);

      const result = await service.getReservation(1);
      expect(result.id).toBe(1);
    });

    it('없는 예약 → RESERVATION_NOT_FOUND 예외', async () => {
      reservationRepository.findByIdWithItems.mockResolvedValue(null);

      await expect(service.getReservation(999)).rejects.toThrow(
        new CustomException(ErrorCode.RESERVATION_NOT_FOUND),
      );
    });
  });

  // ─── cancelReservation ────────────────────────────────────────────────────────

  describe('cancelReservation', () => {
    const cancelDto: CancelReservationDto = {
      userId: 1,
    };

    const buildReservation = (overrides: Partial<Reservation> = {}): Reservation => {
      const res = new Reservation();
      res.id = 1;
      res.userId = 1;
      res.status = ReservationStatus.CONFIRMED;
      res.pickupTime = new Date(Date.now() + 3 * 3600 * 1000);
      res.createdAt = new Date();
      res.items = [Object.assign(new ReservationItem(), { id: 1, inventoryId: 10, qty: 2 })];
      return Object.assign(res, overrides);
    };

    it('정상 취소 — 전액 환불 메시지', async () => {
      const reservation = buildReservation();
      reservationRepository.findByIdWithItems.mockResolvedValue(reservation);
      reservationRepository.save.mockResolvedValue(reservation);
      inventoryRepository.restoreStock.mockResolvedValue(undefined);

      const result = await service.cancelReservation(1, cancelDto);

      expect(result.status).toBe(ReservationStatus.CANCELLED);
      expect(result.feeMessage).toBe('전액 환불됩니다.');
      expect(inventoryRepository.restoreStock).toHaveBeenCalledWith(10, 2, mockManager);
    });

    it('pickup 1시간 미만 남음 — 수수료 메시지', async () => {
      const reservation = buildReservation({ pickupTime: new Date(Date.now() + 30 * 60 * 1000) });
      reservationRepository.findByIdWithItems.mockResolvedValue(reservation);
      reservationRepository.save.mockResolvedValue(reservation);
      inventoryRepository.restoreStock.mockResolvedValue(undefined);

      const result = await service.cancelReservation(1, cancelDto);
      expect(result.feeMessage).toBe('취소 수수료 10%가 부과됩니다.');
    });

    it('예약 없으면 RESERVATION_NOT_FOUND 예외', async () => {
      reservationRepository.findByIdWithItems.mockResolvedValue(null);
      await expect(service.cancelReservation(999, cancelDto)).rejects.toThrow(
        new CustomException(ErrorCode.RESERVATION_NOT_FOUND),
      );
    });

    it('다른 사용자 예약 취소 → FORBIDDEN 예외', async () => {
      reservationRepository.findByIdWithItems.mockResolvedValue(buildReservation({ userId: 99 }));
      await expect(service.cancelReservation(1, cancelDto)).rejects.toThrow(
        new CustomException(ErrorCode.FORBIDDEN),
      );
    });

    it('이미 취소된 예약 → ALREADY_CANCELLED 예외', async () => {
      reservationRepository.findByIdWithItems.mockResolvedValue(
        buildReservation({ status: ReservationStatus.CANCELLED }),
      );
      await expect(service.cancelReservation(1, cancelDto)).rejects.toThrow(
        new CustomException(ErrorCode.ALREADY_CANCELLED),
      );
    });
  });
});
