import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  ManyToOne,
  JoinColumn,
} from 'typeorm';
import { Reservation } from './reservation.entity';
import { Inventory } from '../../inventory/entity/inventory.entity';

@Entity('reservation_item')
export class ReservationItem {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id: number;

  @Column({ name: 'reservation_id', type: 'bigint' })
  reservationId: number;

  @Column({ name: 'inventory_id', type: 'bigint' })
  inventoryId: number;

  @Column({ type: 'int' })
  qty: number;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @ManyToOne(() => Reservation, (reservation) => reservation.items)
  @JoinColumn({ name: 'reservation_id' })
  reservation: Reservation;

  @ManyToOne(() => Inventory)
  @JoinColumn({ name: 'inventory_id' })
  inventory: Inventory;
}
