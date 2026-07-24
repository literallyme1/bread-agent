import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { Store } from '../entity/store.entity';
import { Inventory } from '../../inventory/entity/inventory.entity';
import { Bread } from '../../bread/entity/bread.entity';
import { Tag } from '../../inventory/entity/tag.entity';
import { StoreQueryDto } from '../dto/store-query.dto';
import { StoreRecommendationRow } from '../dto/store-response.dto';

@Injectable()
export class StoreRepository {
  constructor(private readonly dataSource: DataSource) {}

  /** 매장·메뉴·재고·취향 태그를 단일 합성 쿼리로 조회한다. */
  async findCompositeRecommendationCandidates(
    query: StoreQueryDto,
  ): Promise<StoreRecommendationRow[]> {
    const qb = this.dataSource
      .createQueryBuilder()
      .select([
        'store.id        AS store_id',
        'store.name      AS store_name',
        'store.station   AS store_station',
        'store.address   AS store_address',
        'store.open_time AS store_open_time',
        'store.close_time AS store_close_time',
        'inv.id          AS inv_id',
        'bread.id        AS bread_id',
        'bread.name      AS bread_name',
        'inv.price       AS inv_price',
        'inv.available   AS inv_available',
        'ARRAY_AGG(tag.name) FILTER (WHERE tag.name IS NOT NULL) AS tag_names',
      ])
      .from(Store, 'store')
      .leftJoin(Inventory, 'inv', 'inv.store_id = store.id')
      .leftJoin(Bread, 'bread', 'bread.id = inv.bread_id')
      .leftJoin('inventory_tag', 'it', 'it.inventory_id = inv.id')
      .leftJoin(Tag, 'tag', 'tag.id = it.tag_id')
      .where('store.station = :station', { station: query.station });

    if (query.storeName) {
      qb.andWhere(
        '(similarity(store.name, :storeName) > 0.3 OR store.name ILIKE :storeNameLike)',
        { storeName: query.storeName, storeNameLike: `%${query.storeName}%` },
      );
    }

    if (query.breadName) {
      qb.andWhere(
        '(similarity(bread.name, :breadName) > 0.3 OR bread.name ILIKE :breadNameLike)',
        { breadName: query.breadName, breadNameLike: `%${query.breadName}%` },
      );
    }

    if (query.preference && query.preference.length > 0) {
      qb.andWhere(
        `inv.id IN (
          SELECT it2.inventory_id FROM inventory_tag it2
          JOIN tag t2 ON t2.id = it2.tag_id
          WHERE t2.name IN (:...preference)
        )`,
        { preference: query.preference },
      );
    }

    qb.groupBy(
      'store.id, store.name, store.station, store.address, store.open_time, store.close_time, inv.id, bread.id, bread.name, inv.price, inv.available',
    );
    qb.orderBy('store.id', 'ASC').addOrderBy('inv.id', 'ASC');

    return qb.getRawMany<StoreRecommendationRow>();
  }

  /** 매장 식별자로 매장을 조회한다. */
  async findById(id: number): Promise<Store | null> {
    return this.dataSource.getRepository(Store).findOne({ where: { id } });
  }
}
