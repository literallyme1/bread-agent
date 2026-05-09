import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Store } from './store/entity/store.entity';
import { Bread } from './bread/entity/bread.entity';
import { Inventory } from './inventory/entity/inventory.entity';
import { Tag } from './inventory/entity/tag.entity';
import { User } from './user/entity/user.entity';
import { Reservation } from './reservation/entity/reservation.entity';
import { ReservationItem } from './reservation/entity/reservation-item.entity';
import { StoreModule } from './store/store.module';
import { InventoryModule } from './inventory/inventory.module';
import { ReservationModule } from './reservation/reservation.module';
import { RedisModule } from './redis/redis.module';
import { AiModule } from './ai/ai.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env',
    }),

    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      useFactory: (config: ConfigService) => ({
        type: 'postgres',
        host: config.get<string>('DB_HOST', 'localhost'),
        port: config.get<number>('DB_PORT', 5432),
        username: config.get<string>('DB_USERNAME', 'postgres'),
        password: config.get<string>('DB_PASSWORD', 'postgres'),
        database: config.get<string>('DB_DATABASE', 'bread_db'),
        entities: [Store, Bread, Inventory, Tag, User, Reservation, ReservationItem],
        synchronize: config.get<string>('NODE_ENV') !== 'production',
        logging: config.get<string>('NODE_ENV') === 'development',
      }),
      inject: [ConfigService],
    }),

    RedisModule,
    StoreModule,
    InventoryModule,
    ReservationModule,
    AiModule,
  ],
})
export class AppModule {}
