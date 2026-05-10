import { ApiProperty } from '@nestjs/swagger';

/**
 * 아이템별 hold 처리 결과 상태.
 * - SUCCESS      : 요청 수량 전체 확보 성공
 * - OUT_OF_STOCK : 재고 부족으로 확보 실패
 * - ERROR        : 상품 정보 조회 실패 등 시스템 오류
 */
export type HoldItemStatus = 'SUCCESS' | 'OUT_OF_STOCK' | 'ERROR';

export class HoldItemResultDto {
  @ApiProperty({
    example: '101',
    description: '빵 ID',
  })
  id: string;

  @ApiProperty({
    example: '소금빵',
    description: '빵 이름',
  })
  name: string;

  @ApiProperty({
    example: 2,
    description: '요청 수량',
  })
  requestedCount: number;

  @ApiProperty({
    example: 2,
    description: '실제 hold된 수량. 실패 시 0.',
  })
  heldCount: number;

  @ApiProperty({
    example: 'SUCCESS',
    enum: ['SUCCESS', 'OUT_OF_STOCK', 'ERROR'],
    description:
      'hold 처리 결과:\n' +
      '  SUCCESS      - 요청 수량 전체 확보 성공\n' +
      '  OUT_OF_STOCK - 재고 부족으로 확보 실패\n' +
      '  ERROR        - 상품 정보 조회 실패 등 시스템 오류',
  })
  status: HoldItemStatus;

  @ApiProperty({
    example: '재고 부족 (남은 수량: 1개)',
    description: '실패 사유. status가 SUCCESS인 경우 생략됩니다.',
    required: false,
    nullable: true,
  })
  reason?: string;
}

export class HoldResponseDto {
  @ApiProperty({
    example: true,
    description:
      '전체 hold 성공 여부 (All-or-Nothing).\n' +
      '단 하나의 아이템이라도 재고 부족이면 false이며 holdToken은 null입니다.',
  })
  success: boolean;

  @ApiProperty({
    example: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
    description:
      'hold 토큰 (TTL 2분). 전체 hold 성공 시에만 발급됩니다.\n' +
      '실패 시 null이며 Redis Hold는 생성되지 않습니다.',
    nullable: true,
  })
  holdToken: string | null;

  @ApiProperty({
    type: [HoldItemResultDto],
    description: '아이템별 hold 처리 결과 목록',
  })
  items: HoldItemResultDto[];
}
