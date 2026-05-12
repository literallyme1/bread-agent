import { Injectable, Logger } from '@nestjs/common';
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
  private readonly logger = new Logger(StoreService.name);

  constructor(
    private readonly storeRepository: StoreRepository,
    private readonly sessionService: SessionService,
  ) {}

  async getStores(query: StoreQueryDto): Promise<StoreListResponseDto> {
    // Server-Driven 세션 동기화: 리셋 판별 → 프로필 저장 → 자동 승격
    await this.sessionService.syncSearchContext({
      userId: query.userId,
      storeId: query.storeId,
      station: query.station,
      preference: query.preference as string[] | undefined,
    });

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
