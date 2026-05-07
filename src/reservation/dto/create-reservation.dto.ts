import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsArray,
  IsDateString,
  IsInt,
  IsNotEmpty,
  Min,
  ValidateNested,
} from 'class-validator';

export class ReservationItemDto {
  @ApiProperty({ example: 1, description: '빵 ID' })
  @IsNotEmpty()
  @IsInt()
  breadId: number;

  @ApiProperty({ example: 2, description: '예약 수량 (1 이상)', minimum: 1 })
  @IsInt()
  @Min(1)
  qty: number;
}

export class CreateHoldDto {
  @ApiProperty({ example: 1, description: '예약 사용자 ID' })
  @IsNotEmpty()
  @IsInt()
  userId: number;

  @ApiProperty({ example: 1, description: '예약 대상 매장 ID' })
  @IsNotEmpty()
  @IsInt()
  storeId: number;

  @ApiProperty({
    example: '2026-05-08T14:00:00',
    description:
      '픽업 예정 시각 (ISO 8601). ' +
      '현재 시각 이후여야 하며 매장 영업시간(open_time ~ close_time) 범위 내여야 합니다.',
  })
  @IsDateString()
  pickupTime: string;

  @ApiProperty({
    type: [ReservationItemDto],
    description: '예약할 빵 목록 (한 매장에서 여러 종류 동시 예약 가능)',
    example: [
      { breadId: 1, qty: 2 },
      { breadId: 3, qty: 1 },
    ],
  })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ReservationItemDto)
  items: ReservationItemDto[];
}
