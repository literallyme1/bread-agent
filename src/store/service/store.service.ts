import { Injectable } from '@nestjs/common';
import { StoreRepository } from '../repository/store.repository';
import { SessionService } from '../../session/session.service';
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
  constructor(
    private readonly storeRepository: StoreRepository,
    private readonly sessionService: SessionService,
  ) {}

  /** 매장·메뉴·재고·취향을 한 번에 조회하고 검색 상태를 동기화한다. */
  async getStores(query: StoreQueryDto): Promise<StoreListResponseDto> {
    await this.sessionService.syncSearchContext({
      userId: query.userId,
      name: query.name,
      storeId: query.storeId,
      station: query.station,
      preference: query.preference,
    });

    const rows =
      await this.storeRepository.findCompositeRecommendationCandidates(query);
    return mapToStoreListResponse(rows);
  }

  /** 매장 식별자로 상세 정보를 조회한다. */
  async getStoreById(id: number): Promise<StoreDetailDto> {
    const store = await this.storeRepository.findById(id);
    if (!store) {
      throw new CustomException(ErrorCode.STORE_NOT_FOUND);
    }
    return mapToStoreDetail(store);
  }
}
