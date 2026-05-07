import { Injectable } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { Reservation } from '../entity/reservation.entity';
import { ReservationItem } from '../entity/reservation-item.entity';
import { User } from '../../user/entity/user.entity';

/**
 * Reservation DB 접근 담당
 * 트랜잭션이 필요한 경우 EntityManager를 주입받아 처리
 */
@Injectable()
export class ReservationRepository {
  constructor(private readonly dataSource: DataSource) {}

  /**
   * 예약 + 아이템 조회 (N+1 방지: relations 로드)
   */
  async findByIdWithItems(id: number, manager?: EntityManager): Promise<Reservation | null> {
    const repo = manager ? manager.getRepository(Reservation) : this.dataSource.getRepository(Reservation);
    return repo.findOne({
      where: { id },
      relations: ['items'],
    });
  }

  async save(reservation: Reservation, manager?: EntityManager): Promise<Reservation> {
    const repo = manager ? manager.getRepository(Reservation) : this.dataSource.getRepository(Reservation);
    return repo.save(reservation);
  }

  async saveItem(item: ReservationItem, manager?: EntityManager): Promise<ReservationItem> {
    const repo = manager ? manager.getRepository(ReservationItem) : this.dataSource.getRepository(ReservationItem);
    return repo.save(item);
  }

  /**
   * 사용자 존재 확인
   */
  async findUserById(userId: number, manager?: EntityManager): Promise<User | null> {
    const repo = manager ? manager.getRepository(User) : this.dataSource.getRepository(User);
    return repo.findOne({ where: { id: userId } });
  }
}
