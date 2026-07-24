import { DataSource } from 'typeorm';
import { InventoryRepository } from './inventory.repository';
import { CustomException } from '../../common/exception/custom.exception';
import { ErrorCode } from '../../common/exception/error-code.enum';

/**
 * InventoryRepository 단위 테스트
 * 핵심: 조건부 UPDATE 재고 차감 로직 검증
 */
describe('InventoryRepository', () => {
  let repository: InventoryRepository;
  let mockDataSource: Partial<DataSource>;
  let mockQb: any;

  beforeEach(() => {
    mockQb = {
      update: jest.fn().mockReturnThis(),
      set: jest.fn().mockReturnThis(),
      setParameter: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      execute: jest.fn(),
    };

    mockDataSource = {
      createQueryBuilder: jest.fn().mockReturnValue(mockQb),
      getRepository: jest.fn(),
    };

    repository = new InventoryRepository(mockDataSource as DataSource);
  });

  describe('decreaseAvailableStockAtomically', () => {
    it('재고가 충분하면 UPDATE 성공 (affected > 0)', async () => {
      mockQb.execute.mockResolvedValue({ affected: 1 });

      await expect(
        repository.decreaseAvailableStockAtomically(1, 2),
      ).resolves.not.toThrow();

      // WHERE 절에 available >= qty 조건 포함 검증
      expect(mockQb.where).toHaveBeenCalledWith(
        'id = :id AND available >= :qty',
        { id: 1, qty: 2 },
      );
    });

    it('재고 부족 시 OUT_OF_STOCK 예외 (affected === 0)', async () => {
      mockQb.execute.mockResolvedValue({ affected: 0 });

      await expect(
        repository.decreaseAvailableStockAtomically(1, 100),
      ).rejects.toThrow(new CustomException(ErrorCode.OUT_OF_STOCK));
    });
  });

  describe('restoreCancelledStock', () => {
    it('재고 복구 시 available + qty UPDATE', async () => {
      mockQb.execute.mockResolvedValue({ affected: 1 });

      await expect(
        repository.restoreCancelledStock(1, 2),
      ).resolves.not.toThrow();
      expect(mockQb.where).toHaveBeenCalledWith('id = :id', { id: 1 });
    });
  });
});
