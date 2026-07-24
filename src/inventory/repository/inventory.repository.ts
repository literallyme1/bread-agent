import { Injectable } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { Inventory } from '../entity/inventory.entity';
import { CustomException } from '../../common/exception/custom.exception';
import { ErrorCode } from '../../common/exception/error-code.enum';

@Injectable()
export class InventoryRepository {
  constructor(private readonly dataSource: DataSource) {}

  /** 매장과 빵 식별자로 재고를 조회한다. */
  async findByStoreAndBread(
    storeId: number,
    breadId: number,
    manager?: EntityManager,
  ): Promise<Inventory | null> {
    const repo = manager
      ? manager.getRepository(Inventory)
      : this.dataSource.getRepository(Inventory);
    return repo.findOne({ where: { storeId, breadId }, relations: ['bread'] });
  }

  /** 재고 식별자로 재고를 조회한다. */
  async findById(
    id: number,
    manager?: EntityManager,
  ): Promise<Inventory | null> {
    const repo = manager
      ? manager.getRepository(Inventory)
      : this.dataSource.getRepository(Inventory);
    return repo.findOne({ where: { id } });
  }

  /** 조건부 UPDATE로 가용 재고를 원자적으로 차감한다. */
  async decreaseAvailableStockAtomically(
    inventoryId: number,
    qty: number,
    manager?: EntityManager,
  ): Promise<void> {
    const qb = manager
      ? manager.createQueryBuilder()
      : this.dataSource.createQueryBuilder();

    const result = await qb
      .update(Inventory)
      .set({ available: () => 'available - :qty' })
      .setParameter('qty', qty)
      .where('id = :id AND available >= :qty', { id: inventoryId, qty })
      .execute();

    if (result.affected === 0) {
      throw new CustomException(ErrorCode.OUT_OF_STOCK);
    }
  }

  /** 취소된 예약 수량을 가용 재고로 복구한다. */
  async restoreCancelledStock(
    inventoryId: number,
    qty: number,
    manager?: EntityManager,
  ): Promise<void> {
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
