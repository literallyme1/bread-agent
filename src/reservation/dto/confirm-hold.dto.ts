import { IsInt, IsNotEmpty, IsString } from 'class-validator';

/**
 * POST /v1/reservations/confirm 요청 바디.
 * holdToken 기반으로 Redis Hold → DB Reservation 확정.
 */
export class ConfirmHoldDto {
  @IsNotEmpty()
  @IsInt()
  userId: number;

  @IsNotEmpty()
  @IsString()
  holdToken: string;
}
