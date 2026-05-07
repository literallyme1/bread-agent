import { Injectable } from '@nestjs/common';
import { StoreRepository } from '../repository/store.repository';
import { StoreQueryDto } from '../dto/store-query.dto';
import {
  StoreDetailDto,
  StoreListResponseDto,
  mapToStoreDetail,
  mapToStoreListResponse,
} from '../dto/store-response.dto';
import { CustomException } from '../../common/exception/custom.exception';
import { ErrorCode } from '../../common/exception/error-code.enum';

@Injectable()
export class StoreService {
  constructor(private readonly storeRepository: StoreRepository) {}

  async getStores(query: StoreQueryDto): Promise<StoreListResponseDto> {
    const rows = await this.storeRepository.findStoresWithBreads(query);
    return mapToStoreListResponse(rows);
  }

  async getStoreById(id: number): Promise<StoreDetailDto> {
    const store = await this.storeRepository.findById(id);
    if (!store) {
      throw new CustomException(ErrorCode.STORE_NOT_FOUND);
    }
    return mapToStoreDetail(store);
  }
}
