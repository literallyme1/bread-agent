import { Injectable, Inject } from '@nestjs/common';
import { Redis } from 'ioredis';
import { REDIS_CLIENT } from './redis.constants';

export interface HoldItem {
  inventoryId: number;
  breadId: number;
  breadName: string;
  requestedQty: number;
  heldQty: number;
}

export interface HoldData {
  userId: number;
  storeId: number;
  pickupTime: string;
  items: HoldItem[];
  expiresAt: string;
}

export const HOLD_TTL_SECONDS = 120;

@Injectable()
export class RedisHoldService {
  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  async createHold(token: string, data: HoldData): Promise<void> {
    await this.redis.set(
      `hold:${token}`,
      JSON.stringify(data),
      'EX',
      HOLD_TTL_SECONDS,
    );
  }

  async getHold(token: string): Promise<HoldData | null> {
    const raw = await this.redis.get(`hold:${token}`);
    if (!raw) return null;
    return JSON.parse(raw) as HoldData;
  }

  async deleteHold(token: string): Promise<void> {
    await this.redis.del(`hold:${token}`);
  }

  async getTtl(token: string): Promise<number> {
    return this.redis.ttl(`hold:${token}`);
  }
}
