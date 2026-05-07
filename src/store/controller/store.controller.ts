import { Controller, Get, Param, ParseIntPipe, Query } from '@nestjs/common';
import {
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { StoreService } from '../service/store.service';
import { StoreQueryDto } from '../dto/store-query.dto';
import { ApiResponse, errorSchema } from '../../common/dto/api-response.dto';
import { StoreDetailDto, StoreListResponseDto } from '../dto/store-response.dto';

@ApiTags('Stores')
@Controller('v1/stores')
export class StoreController {
  constructor(private readonly storeService: StoreService) {}

  /**
   * GET /v1/stores?station=강남역&breadName=소금빵&preference=짭짤&storeName=하레하레
   */
  @Get()
  @ApiOperation({
    summary: '매장 목록 조회',
    description:
      '역 이름 기준으로 매장·재고·태그를 한 번에 조회합니다. ' +
      'storeName / breadName은 pg_trgm 유사 검색이 적용되어 오타를 보완합니다. ' +
      'preference는 정확히 일치하는 태그만 반환합니다.',
  })
  @ApiOkResponse({
    description: '매장 목록 반환',
    schema: {
      example: {
        data: {
          stores: [
            {
              id: 1,
              name: '하레하레 강남',
              station: '강남역',
              address: '서울 강남구 강남대로 100',
              openTime: '09:00',
              closeTime: '22:00',
              breads: [
                {
                  id: 1,
                  name: '소금빵',
                  price: 3200,
                  stock: 12,
                  preferences: ['짭짤', '바삭'],
                },
              ],
            },
          ],
        },
        message: 'Stores fetched successfully',
      },
    },
  })
  async getStores(@Query() query: StoreQueryDto): Promise<ApiResponse<StoreListResponseDto>> {
    const data = await this.storeService.getStores(query);
    return ApiResponse.success(data, 'Stores fetched successfully');
  }

  /**
   * GET /v1/stores/:id
   */
  @Get(':id')
  @ApiOperation({ summary: '매장 상세 조회', description: '매장 ID로 상세 정보를 반환합니다.' })
  @ApiOkResponse({
    description: '매장 상세 정보',
    schema: {
      example: {
        data: {
          id: 1,
          name: '하레하레 강남',
          station: '강남역',
          address: '서울 강남구 강남대로 100',
          openTime: '09:00',
          closeTime: '22:00',
        },
        message: 'Store fetched successfully',
      },
    },
  })
  @ApiNotFoundResponse({
    description: '매장을 찾을 수 없음',
    schema: errorSchema('Store not found'),
  })
  async getStore(
    @Param('id', ParseIntPipe) id: number,
  ): Promise<ApiResponse<StoreDetailDto>> {
    const data = await this.storeService.getStoreById(id);
    return ApiResponse.success(data, 'Store fetched successfully');
  }
}
