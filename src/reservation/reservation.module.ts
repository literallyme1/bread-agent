import { Module } from '@nestjs/common';
import { ReservationController } from './controller/reservation.controller';
import { ReservationService } from './service/reservation.service';
import { ReservationRepository } from './repository/reservation.repository';
import { InventoryModule } from '../inventory/inventory.module';
import { StoreModule } from '../store/store.module';

// RedisHoldService 는 RedisModule(@Global)에서 자동 주입됨

@Module({
  imports: [InventoryModule, StoreModule],
  controllers: [ReservationController],
  providers: [ReservationService, ReservationRepository],
})
export class ReservationModule {}
