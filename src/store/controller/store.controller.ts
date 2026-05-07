import { Controller, Get, Param, ParseIntPipe, Query } from '@nestjs/common';
import { StoreService } from '../service/store.service';
import { StoreQueryDto } from '../dto/store-query.dto';
import { ApiResponse } from '../../common/dto/api-response.dto';

@Controller('v1/stores')
export class StoreController {
  constructor(private readonly storeService: StoreService) {}

  /**
   * GET /v1/stores?station=대전역&breadName=소금빵&preference=짭짤&storeName=성심당
   * pg_trgm 유사 검색 적용 (breadName, storeName).
   * preference 는 exact match.
   */
  @Get()
  async getStores(@Query() query: StoreQueryDto): Promise<ApiResponse<any>> {
    const data = await this.storeService.getStores(query);
    return ApiResponse.success(data, 'Stores fetched successfully');
  }

  /**
   * GET /v1/stores/:id
   * 매장 상세 조회
   */
  @Get(':id')
  async getStore(@Param('id', ParseIntPipe) id: number): Promise<ApiResponse<any>> {
    const data = await this.storeService.getStoreById(id);
    return ApiResponse.success(data, 'Store fetched successfully');
  }
}
