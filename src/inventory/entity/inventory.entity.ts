import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  ManyToMany,
  JoinTable,
  JoinColumn,
  Index,
  Check,
} from 'typeorm';
import { Store } from '../../store/entity/store.entity';
import { Bread } from '../../bread/entity/bread.entity';
import { Tag } from './tag.entity';

@Entity('inventory')
@Index(['storeId', 'breadId'])
@Check('"available" >= 0')
export class Inventory {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id: number;

  @Column({ name: 'store_id', type: 'bigint' })
  storeId: number;

  @Column({ name: 'bread_id', type: 'bigint' })
  breadId: number;

  @Column({ type: 'int' })
  price: number;

  @Column({ type: 'int' })
  available: number;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;

  @ManyToOne(() => Store)
  @JoinColumn({ name: 'store_id' })
  store: Store;

  @ManyToOne(() => Bread)
  @JoinColumn({ name: 'bread_id' })
  bread: Bread;

  /**
   * inventory_tag 조인 테이블 (composite PK: inventory_id + tag_id)
   */
  @ManyToMany(() => Tag)
  @JoinTable({
    name: 'inventory_tag',
    joinColumn: { name: 'inventory_id', referencedColumnName: 'id' },
    inverseJoinColumn: { name: 'tag_id', referencedColumnName: 'id' },
  })
  tags: Tag[];

  /**
   * 재고 복구 - 예약 취소 시 호출
   * (실제 DB 반영은 Repository의 restoreStock 참고)
   */
  restoreStock(qty: number): void {
    this.available += qty;
  }
}
