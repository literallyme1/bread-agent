export class BreadItemDto {
  id: number;
  name: string;
  price: number;
  stock: number;
  preferences: string[];
}

export class StoreDto {
  id: number;
  name: string;
  station: string;
  address: string;
  openTime: string;
  closeTime: string;
  breads: BreadItemDto[];
}

export class StoreDetailDto {
  id: number;
  name: string;
  station: string;
  address: string;
  openTime: string;
  closeTime: string;
}

export class StoreListResponseDto {
  stores: StoreDto[];

  constructor(stores: StoreDto[]) {
    this.stores = stores;
  }
}

/**
 * QueryBuilder raw 결과를 StoreListResponseDto로 변환
 * N+1 없이 단일 쿼리 결과에서 그룹핑
 *
 * tag_names: ARRAY_AGG 결과 (string[] | null)
 */
export function mapToStoreListResponse(
  rows: {
    store_id: number;
    store_name: string;
    store_station: string;
    store_address: string;
    store_open_time: string;
    store_close_time: string;
    inv_id: number;
    bread_id: number;
    bread_name: string;
    inv_price: number;
    inv_available: number;
    tag_names: string[] | null;
  }[],
): StoreListResponseDto {
  const storeMap = new Map<number, StoreDto>();

  for (const row of rows) {
    if (!storeMap.has(row.store_id)) {
      storeMap.set(row.store_id, {
        id: Number(row.store_id),
        name: row.store_name,
        station: row.store_station,
        address: row.store_address,
        openTime: row.store_open_time,
        closeTime: row.store_close_time,
        breads: [],
      });
    }

    if (row.inv_id != null) {
      storeMap.get(row.store_id)!.breads.push({
        id: Number(row.bread_id),
        name: row.bread_name,
        price: row.inv_price,
        stock: row.inv_available,
        preferences: (row.tag_names ?? []).filter(Boolean),
      });
    }
  }

  return new StoreListResponseDto(Array.from(storeMap.values()));
}

export function mapToStoreDetail(store: {
  id: number;
  name: string;
  station: string;
  address: string;
  openTime: string;
  closeTime: string;
}): StoreDetailDto {
  return {
    id: Number(store.id),
    name: store.name,
    station: store.station,
    address: store.address,
    openTime: store.openTime,
    closeTime: store.closeTime,
  };
}
