import { ApiProperty } from '@nestjs/swagger';
import { IsInt, IsNotEmpty } from 'class-validator';

export class CancelReservationDto {
  @ApiProperty({ example: 1, description: '취소 요청 사용자 ID (권한 검증)' })
  @IsNotEmpty()
  @IsInt()
  userId: number;
}
