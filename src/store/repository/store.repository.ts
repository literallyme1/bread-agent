import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { Store } from '../entity/store.entity';
import { Inventory } from '../../inventory/entity/inventory.entity';
import { Bread } from '../../bread/entity/bread.entity';
import { Tag } from '../../inventory/entity/tag.entity';
import { StoreQueryDto } from '../dto/store-query.dto';

/**
 * Store 관련 DB 접근 담당.
 * Composite 조회는 단일 QueryBuilder 쿼리로 N+1 없이 처리.
 *
 * pg_trgm 유사 검색 사용을 위해 PostgreSQL에
 * `CREATE EXTENSION IF NOT EXISTS pg_trgm;` 이 적용되어 있어야 합니다.
 */
@Injectable()
export class StoreRepository {
  constructor(private readonly dataSource: DataSource) {}

  /**
   * station 기반 Composite 조회.
   * - storeName / breadName: pg_trgm similarity + ILIKE 복합 검색 (오타 보완)
   * - preference(tag): exact match 유지
   * - tag 집계: ARRAY_AGG (배열 반환)
   */
  async findStoresWithBreads(query: StoreQueryDto): Promise<any[]> {
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
      // pg_trgm 유사도 OR ILIKE 병행 — 오타 보완 + 부분 검색 동시 지원
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
      // 태그 exact match, 복수 전달 시 OR 조건 (하나라도 포함된 inventory 반환)
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

    return qb.getRawMany();
  }

  async findById(id: number): Promise<Store | null> {
    return this.dataSource.getRepository(Store).findOne({ where: { id } });
  }
}
