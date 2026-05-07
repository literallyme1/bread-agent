import { Entity, PrimaryGeneratedColumn, Column } from 'typeorm';

@Entity('tag')
export class Tag {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id: number;

  @Column({ type: 'varchar', length: 100 })
  name: string;
}
