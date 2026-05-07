import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class StoreQueryDto {
  @ApiProperty({
    example: '강남역',
    description: '지하철역 이름 (필수)',
  })
  @IsNotEmpty({ message: 'station is required' })
  @IsString()
  station: string;

  @ApiPropertyOptional({
    example: '소금빵',
    description: '빵 이름 (pg_trgm 유사 검색 적용 — 오타 보완 가능)',
  })
  @IsOptional()
  @IsString()
  breadName?: string;

  @ApiPropertyOptional({
    example: '짭짤',
    description: '태그(preference) — exact match',
  })
  @IsOptional()
  @IsString()
  preference?: string;

  @ApiPropertyOptional({
    example: '하레하레',
    description: '매장 이름 (pg_trgm 유사 검색 적용 — 오타 보완 가능)',
  })
  @IsOptional()
  @IsString()
  storeName?: string;
}
