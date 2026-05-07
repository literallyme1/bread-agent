import { ApiProperty } from '@nestjs/swagger';
import { IsInt, IsNotEmpty, IsString } from 'class-validator';

export class ConfirmHoldDto {
  @ApiProperty({ example: 1, description: '예약 사용자 ID' })
  @IsNotEmpty()
  @IsInt()
  userId: number;

  @ApiProperty({
    example: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
    description: 'hold 생성 시 발급된 토큰 (TTL 2분)',
  })
  @IsNotEmpty()
  @IsString()
  holdToken: string;
}
