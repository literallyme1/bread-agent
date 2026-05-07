import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  ManyToOne,
  OneToMany,
  JoinColumn,
} from 'typeorm';
import { User } from '../../user/entity/user.entity';
import { ReservationItem } from './reservation-item.entity';

/**
 * HELD / OUT_OF_STOCK 는 Redis Hold + DTO 레벨에서만 처리.
 * DB에는 저장하지 않음.
 */
export enum ReservationStatus {
  CONFIRMED = 'CONFIRMED',
  CANCELLED = 'CANCELLED',
}

@Entity('reservation')
export class Reservation {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id: number;

  @Column({ name: 'user_id', type: 'bigint' })
  userId: number;

  @Column({ type: 'varchar', length: 20 })
  status: ReservationStatus;

  @Column({ name: 'pickup_time', type: 'timestamp' })
  pickupTime: Date;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @ManyToOne(() => User)
  @JoinColumn({ name: 'user_id' })
  user: User;

  @OneToMany(() => ReservationItem, (item) => item.reservation, { cascade: true })
  items: ReservationItem[];

  cancel(): void {
    if (this.status === ReservationStatus.CANCELLED) {
      throw new Error('ALREADY_CANCELLED');
    }
    this.status = ReservationStatus.CANCELLED;
  }

  isWithinOneHourOfPickup(): boolean {
    const oneHourBefore = new Date(this.pickupTime.getTime() - 60 * 60 * 1000);
    return new Date() >= oneHourBefore;
  }
}
