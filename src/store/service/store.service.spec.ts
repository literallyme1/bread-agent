import { Test, TestingModule } from '@nestjs/testing';
import { StoreService } from './store.service';
import { StoreRepository } from '../repository/store.repository';
import { StoreQueryDto } from '../dto/store-query.dto';
import { CustomException } from '../../common/exception/custom.exception';
import { ErrorCode } from '../../common/exception/error-code.enum';
import { Store } from '../entity/store.entity';

describe('StoreService', () => {
  let service: StoreService;
  let storeRepository: jest.Mocked<StoreRepository>;

  beforeEach(async () => {
    storeRepository = {
      findStoresWithBreads: jest.fn(),
      findById: jest.fn(),
    } as any;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        StoreService,
        { provide: StoreRepository, useValue: storeRepository },
      ],
    }).compile();

    service = module.get<StoreService>(StoreService);
  });

  // ─── getStores ──────────────────────────────────────────────────────────────

  describe('getStores', () => {
    it('raw rows를 StoreListResponseDto로 변환 (tag_names 배열)', async () => {
      const rawRows = [
        {
          store_id: 1,
          store_name: '성심당',
          store_station: '대전역',
          store_address: '대전 중구 중앙로 123',
          store_open_time: '09:00:00',
          store_close_time: '22:00:00',
          inv_id: 10,
          bread_id: 2,
          bread_name: '소금빵',
          inv_price: 3000,
          inv_available: 5,
          tag_names: ['짭짤', '담백'],
        },
      ];
      storeRepository.findStoresWithBreads.mockResolvedValue(rawRows);

      const query: StoreQueryDto = { station: '대전역' };
      const result = await service.getStores(query);

      expect(result.stores).toHaveLength(1);
      expect(result.stores[0].name).toBe('성심당');
      expect(result.stores[0].address).toBe('대전 중구 중앙로 123');
      expect(result.stores[0].openTime).toBe('09:00:00');
      expect(result.stores[0].closeTime).toBe('22:00:00');
      expect(result.stores[0].breads).toHaveLength(1);
      expect(result.stores[0].breads[0].name).toBe('소금빵');
      expect(result.stores[0].breads[0].price).toBe(3000);
      expect(result.stores[0].breads[0].stock).toBe(5);
      // ARRAY_AGG 결과 배열 검증
      expect(result.stores[0].breads[0].preferences).toEqual(['짭짤', '담백']);
    });

    it('tag_names가 null이면 preferences는 빈 배열', async () => {
      const rawRows = [
        {
          store_id: 1,
          store_name: '성심당',
          store_station: '대전역',
          store_address: '대전 중구 중앙로 123',
          store_open_time: '09:00:00',
          store_close_time: '22:00:00',
          inv_id: 10,
          bread_id: 2,
          bread_name: '소금빵',
          inv_price: 3000,
          inv_available: 5,
          tag_names: null,
        },
      ];
      storeRepository.findStoresWithBreads.mockResolvedValue(rawRows);

      const result = await service.getStores({ station: '대전역' });
      expect(result.stores[0].breads[0].preferences).toEqual([]);
    });

    it('결과가 없으면 빈 stores 배열 반환', async () => {
      storeRepository.findStoresWithBreads.mockResolvedValue([]);

      const result = await service.getStores({ station: '없는역' });
      expect(result.stores).toHaveLength(0);
    });

    it('inv_id가 null인 row는 breads에 추가하지 않음 (빵 없는 매장)', async () => {
      const rawRows = [
        {
          store_id: 1,
          store_name: '성심당',
          store_station: '대전역',
          store_address: '대전 중구 중앙로 123',
          store_open_time: '09:00:00',
          store_close_time: '22:00:00',
          inv_id: null,
          bread_id: null,
          bread_name: null,
          inv_price: null,
          inv_available: null,
          tag_names: null,
        },
      ];
      storeRepository.findStoresWithBreads.mockResolvedValue(rawRows);

      const result = await service.getStores({ station: '대전역' });
      expect(result.stores[0].breads).toHaveLength(0);
    });

    it('여러 매장이 각자 breads를 올바르게 그룹핑', async () => {
      const rawRows = [
        {
          store_id: 1,
          store_name: '성심당',
          store_station: '대전역',
          store_address: '대전 중구 중앙로 1',
          store_open_time: '09:00:00',
          store_close_time: '22:00:00',
          inv_id: 10,
          bread_id: 1,
          bread_name: '소금빵',
          inv_price: 3000,
          inv_available: 5,
          tag_names: ['짭짤'],
        },
        {
          store_id: 2,
          store_name: '하레하레',
          store_station: '대전역',
          store_address: '대전 중구 중앙로 2',
          store_open_time: '10:00:00',
          store_close_time: '21:00:00',
          inv_id: 20,
          bread_id: 2,
          bread_name: '고구마빵',
          inv_price: 2500,
          inv_available: 3,
          tag_names: ['달콤'],
        },
      ];
      storeRepository.findStoresWithBreads.mockResolvedValue(rawRows);

      const result = await service.getStores({ station: '대전역' });

      expect(result.stores).toHaveLength(2);
      expect(result.stores[0].name).toBe('성심당');
      expect(result.stores[1].name).toBe('하레하레');
    });
  });

  // ─── pg_trgm 유사 검색 (Repository 레벨 동작 검증) ─────────────────────────

  describe('getStores - pg_trgm 유사 검색 쿼리 위임', () => {
    it('storeName 전달 시 repository에 query 그대로 위임', async () => {
      storeRepository.findStoresWithBreads.mockResolvedValue([]);

      await service.getStores({ station: '대전역', storeName: '하래하래' });

      expect(storeRepository.findStoresWithBreads).toHaveBeenCalledWith(
        expect.objectContaining({ storeName: '하래하래' }),
      );
    });

    it('breadName 전달 시 repository에 query 그대로 위임 (오타 보완 대상)', async () => {
      storeRepository.findStoresWithBreads.mockResolvedValue([]);

      await service.getStores({ station: '대전역', breadName: '소금빵집' });

      expect(storeRepository.findStoresWithBreads).toHaveBeenCalledWith(
        expect.objectContaining({ breadName: '소금빵집' }),
      );
    });
  });

  // ─── getStoreById ────────────────────────────────────────────────────────────

  describe('getStoreById', () => {
    it('존재하는 매장 조회 시 StoreDetailDto 반환', async () => {
      const mockStore: Partial<Store> = {
        id: 1,
        name: '성심당',
        station: '대전역',
        address: '대전 중구 중앙로 123',
        openTime: '09:00:00',
        closeTime: '22:00:00',
      };
      storeRepository.findById.mockResolvedValue(mockStore as Store);

      const result = await service.getStoreById(1);

      expect(result.id).toBe(1);
      expect(result.name).toBe('성심당');
      expect(result.station).toBe('대전역');
      expect(result.address).toBe('대전 중구 중앙로 123');
      expect(result.openTime).toBe('09:00:00');
      expect(result.closeTime).toBe('22:00:00');
    });

    it('존재하지 않는 매장이면 STORE_NOT_FOUND 예외', async () => {
      storeRepository.findById.mockResolvedValue(null);

      await expect(service.getStoreById(999)).rejects.toThrow(
        new CustomException(ErrorCode.STORE_NOT_FOUND),
      );
    });
  });
});
