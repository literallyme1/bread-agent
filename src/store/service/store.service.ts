import { Injectable, Logger } from '@nestjs/common';
import { StoreRepository } from '../repository/store.repository';
import { RedisHoldService } from '../../redis/redis.service';
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
    private readonly redisService: RedisHoldService,
  ) {}

  async getStores(query: StoreQueryDto): Promise<StoreListResponseDto> {
    const rows = await this.storeRepository.findStoresWithBreads(query);
    const result = mapToStoreListResponse(rows);

    // Side-effect: userId가 있을 때 station / preference를 Redis profile에 자동 저장.
    // 둘 중 하나만 전달돼도 해당 필드만 부분 업데이트합니다.
    if (query.userId) {
      const profilePatch: { preferred_station?: string; taste_tags?: string[] } = {};

      if (query.station) {
        profilePatch.preferred_station = query.station;
      }
      if (query.preference && query.preference.length > 0) {
        profilePatch.taste_tags = query.preference as string[];
      }

      if (Object.keys(profilePatch).length > 0) {
        await this.redisService.updateProfile(query.userId, profilePatch);
        this.logger.log(
          `[getStores] profile auto-saved userId=${query.userId}` +
            (profilePatch.preferred_station ? ` preferred_station=${profilePatch.preferred_station}` : '') +
            (profilePatch.taste_tags ? ` taste_tags=${JSON.stringify(profilePatch.taste_tags)}` : ''),
        );
      }
    }

    return result;
  }

  async getStoreById(id: number): Promise<StoreDetailDto> {
    const store = await this.storeRepository.findById(id);
    if (!store) {
      throw new CustomException(ErrorCode.STORE_NOT_FOUND);
    }
    return mapToStoreDetail(store);
  }
}
