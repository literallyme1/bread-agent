import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn } from 'typeorm';

@Entity('store')
export class Store {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id: number;

  @Column({ type: 'varchar', length: 100 })
  name: string;

  @Column({ type: 'varchar', length: 100 })
  station: string;

  @Column({ type: 'varchar', length: 255 })
  address: string;

  @Column({ name: 'open_time', type: 'time' })
  openTime: string;

  @Column({ name: 'close_time', type: 'time' })
  closeTime: string;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;
}
