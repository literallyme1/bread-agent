import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsArray, IsNotEmpty, IsOptional, IsString } from 'class-validator';

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
    type: [String],
    example: ['짭짤', '바삭'],
    description:
      '태그(preference) 필터 — exact match, 여러 개 전달 시 OR 조건 적용\n' +
      '(e.g. ?preference=짭짤&preference=바삭)',
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @Transform(({ value }) => (Array.isArray(value) ? value : [value]))
  preference?: string[];

  @ApiPropertyOptional({
    example: '하레하레',
    description: '매장 이름 (pg_trgm 유사 검색 적용 — 오타 보완 가능)',
  })
  @IsOptional()
  @IsString()
  storeName?: string;
}
