import { Module } from '@nestjs/common';
import { InventoryRepository } from './repository/inventory.repository';

@Module({
  providers: [InventoryRepository],
  exports: [InventoryRepository],
})
export class InventoryModule {}
