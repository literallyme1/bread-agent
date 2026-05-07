import { ApiProperty } from '@nestjs/swagger';

export type HoldItemStatus = 'HELD' | 'OUT_OF_STOCK';

export class HoldItemResultDto {
  @ApiProperty({ example: '소금빵', description: '빵 이름' })
  breadName: string;

  @ApiProperty({ example: 2, description: '요청 수량' })
  requestedQty: number;

  @ApiProperty({ example: 2, description: '실제 hold된 수량 (재고 부족 시 0)' })
  heldQty: number;

  @ApiProperty({
    example: 'HELD',
    enum: ['HELD', 'OUT_OF_STOCK'],
    description: 'HELD: 재고 확보 성공 / OUT_OF_STOCK: 재고 부족',
  })
  status: HoldItemStatus;
}

export class HoldResponseDto {
  @ApiProperty({
    example: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
    description: 'hold 토큰 (2분 TTL). confirm 시 사용.',
  })
  holdToken: string;

  @ApiProperty({ type: [HoldItemResultDto], description: '아이템별 hold 결과' })
  items: HoldItemResultDto[];
}
