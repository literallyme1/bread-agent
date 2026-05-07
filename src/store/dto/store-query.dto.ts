import { IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class StoreQueryDto {
  /**
   * 지하철역 이름 - 필수
   */
  @IsNotEmpty({ message: 'station is required' })
  @IsString()
  station: string;

  /**
   * 빵 이름 필터 - 선택
   */
  @IsOptional()
  @IsString()
  breadName?: string;

  /**
   * 태그(preference) 필터 - 선택
   */
  @IsOptional()
  @IsString()
  preference?: string;

  /**
   * 매장 이름 필터 - 선택
   */
  @IsOptional()
  @IsString()
  storeName?: string;
}
