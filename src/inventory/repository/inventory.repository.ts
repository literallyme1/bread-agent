import { Injectable } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { Inventory } from '../entity/inventory.entity';
import { CustomException } from '../../common/exception/custom.exception';
import { ErrorCode } from '../../common/exception/error-code.enum';

/**
 * Inventory DB 접근 담당
 * 재고 관련 핵심 동시성 처리 로직 포함
 */
@Injectable()
export class InventoryRepository {
  constructor(private readonly dataSource: DataSource) {}

  /**
   * store_id + bread_id 조합으로 inventory 조회
   */
  async findByStoreAndBread(storeId: number, breadId: number, manager?: EntityManager): Promise<Inventory | null> {
    const repo = manager ? manager.getRepository(Inventory) : this.dataSource.getRepository(Inventory);
    return repo.findOne({ where: { storeId, breadId }, relations: ['bread'] });
  }

  async findById(id: number, manager?: EntityManager): Promise<Inventory | null> {
    const repo = manager ? manager.getRepository(Inventory) : this.dataSource.getRepository(Inventory);
    return repo.findOne({ where: { id } });
  }

  /**
   * 조건부 UPDATE 방식으로 재고 차감 (동시성 안전)
   *
   * UPDATE inventory
   *   SET available = available - :qty
   * WHERE id = :id AND available >= :qty
   *
   * affected === 0 이면 재고 부족으로 실패
   * 낙관적 락 없이 DB 레벨에서 atomically 처리
   */
  async decreaseStock(inventoryId: number, qty: number, manager?: EntityManager): Promise<void> {
    const qb = manager
      ? manager.createQueryBuilder()
      : this.dataSource.createQueryBuilder();

    const result = await qb
      .update(Inventory)
      .set({ available: () => 'available - :qty' })
      .setParameter('qty', qty)
      .where('id = :id AND available >= :qty', { id: inventoryId, qty })
      .execute();

    if (result.affected === 0) { // 수정한 행 개수 0
      throw new CustomException(ErrorCode.OUT_OF_STOCK);
    }
  }

  /**
   * 재고 복구 - 예약 취소 시 호출
   * 취소는 단순 증가이므로 조건 없이 UPDATE
   */
  async restoreStock(inventoryId: number, qty: number, manager?: EntityManager): Promise<void> {
    const qb = manager
      ? manager.createQueryBuilder()
      : this.dataSource.createQueryBuilder();

    await qb
      .update(Inventory)
      .set({ available: () => 'available + :qty' })
      .setParameter('qty', qty)
      .where('id = :id', { id: inventoryId })
      .execute();
  }
}
