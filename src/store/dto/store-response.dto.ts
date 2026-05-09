import { ApiProperty } from '@nestjs/swagger';

export class BreadItemDto {
  @ApiProperty({ example: 1, description: '빵 ID' })
  id: number;

  @ApiProperty({ example: '소금빵', description: '빵 이름' })
  name: string;

  @ApiProperty({ example: 3200, description: '가격 (원)' })
  price: number;

  @ApiProperty({ example: 12, description: '남은 재고 수량' })
  stock: number;

  @ApiProperty({
    example: ['짭짤', '바삭'],
    description: '태그(preference) 목록',
    type: [String],
  })
  preferences: string[];
}

export class StoreDto {
  @ApiProperty({ example: 1, description: '매장 ID' })
  id: number;

  @ApiProperty({ example: '하레하레 강남', description: '매장 이름' })
  name: string;

  @ApiProperty({ example: '강남역', description: '인근 지하철역' })
  station: string;

  @ApiProperty({ example: '서울 강남구 강남대로 100', description: '매장 주소' })
  address: string;

  @ApiProperty({ example: '09:00', description: '영업 시작 시간 (HH:mm)' })
  openTime: string;

  @ApiProperty({ example: '22:00', description: '영업 종료 시간 (HH:mm)' })
  closeTime: string;

  @ApiProperty({ type: [BreadItemDto], description: '보유 빵 목록' })
  breads: BreadItemDto[];
}

export class StoreDetailDto {
  @ApiProperty({ example: 1 })
  id: number;

  @ApiProperty({ example: '하레하레 강남' })
  name: string;

  @ApiProperty({ example: '강남역' })
  station: string;

  @ApiProperty({ example: '서울 강남구 강남대로 100' })
  address: string;

  @ApiProperty({ example: '09:00' })
  openTime: string;

  @ApiProperty({ example: '22:00' })
  closeTime: string;
}

export class StoreListResponseDto {
  @ApiProperty({ type: [StoreDto] })
  stores: StoreDto[];

  constructor(stores: StoreDto[]) {
    this.stores = stores;
  }
}

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
