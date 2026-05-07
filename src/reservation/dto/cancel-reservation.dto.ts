import { IsInt, IsNotEmpty } from 'class-validator';

export class CancelReservationDto {
  /**
   * 취소 요청 사용자 식별용
   */
  @IsNotEmpty()
  @IsInt()
  userId: number;
}
