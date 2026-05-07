import { Module } from '@nestjs/common';
import { StoreController } from './controller/store.controller';
import { StoreService } from './service/store.service';
import { StoreRepository } from './repository/store.repository';

@Module({
  controllers: [StoreController],
  providers: [StoreService, StoreRepository],
  exports: [StoreRepository],
})
export class StoreModule {}
