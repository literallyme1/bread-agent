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
  @IsNotEmpty()
  @IsInt()
  breadId: number;

  @IsInt()
  @Min(1)
  qty: number;
}

/**
 * POST /v1/reservations/hold 요청 바디.
 * 한 매장에서 여러 빵을 동시에 hold 요청.
 */
export class CreateHoldDto {
  @IsNotEmpty()
  @IsInt()
  userId: number;

  @IsNotEmpty()
  @IsInt()
  storeId: number;

  /**
   * ISO 8601 형식 (e.g. "2026-03-15T18:30:00").
   * 서비스 레이어에서 multi-step 검증 적용:
   *   1) 파싱 가능 여부
   *   2) 현재 이후 시간인지
   *   3) 영업시간(09:00–21:00) 범위인지
   */
  @IsDateString()
  pickupTime: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ReservationItemDto)
  items: ReservationItemDto[];
}
