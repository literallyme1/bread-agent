import { ApiProperty } from '@nestjs/swagger';
import { Reservation, ReservationStatus } from '../entity/reservation.entity';
import { ReservationItem } from '../entity/reservation-item.entity';

export class ReservationItemResponseDto {
  @ApiProperty({ example: 1, description: '예약 아이템 ID' })
  id: number;

  @ApiProperty({ example: 10, description: '재고(inventory) ID' })
  inventoryId: number;

  @ApiProperty({ example: 2, description: '예약 수량' })
  qty: number;

  static from(item: ReservationItem): ReservationItemResponseDto {
    return {
      id: Number(item.id),
      inventoryId: Number(item.inventoryId),
      qty: item.qty,
    };
  }
}

export class ReservationResponseDto {
  @ApiProperty({ example: 1, description: '예약 ID' })
  id: number;

  @ApiProperty({ example: 1, description: '사용자 ID' })
  userId: number;

  @ApiProperty({
    example: 'CONFIRMED',
    enum: ReservationStatus,
    description: '예약 상태 (CONFIRMED | CANCELLED)',
  })
  status: ReservationStatus;

  @ApiProperty({ example: '2026-05-08T14:00:00.000Z', description: '픽업 예정 시각' })
  pickupTime: Date;

  @ApiProperty({ example: '2026-05-07T10:00:00.000Z', description: '예약 생성 시각' })
  createdAt: Date;

  @ApiProperty({ type: [ReservationItemResponseDto] })
  items: ReservationItemResponseDto[];

  static from(reservation: Reservation): ReservationResponseDto {
    return {
      id: Number(reservation.id),
      userId: Number(reservation.userId),
      status: reservation.status,
      pickupTime: reservation.pickupTime,
      createdAt: reservation.createdAt,
      items: reservation.items?.map(ReservationItemResponseDto.from) ?? [],
    };
  }
}

export class CancelReservationResponseDto {
  @ApiProperty({ example: 1, description: '예약 ID' })
  id: number;

  @ApiProperty({ example: 'CANCELLED', enum: ReservationStatus })
  status: ReservationStatus;

  @ApiProperty({
    example: '전액 환불됩니다.',
    description: '수수료 안내 메시지 (픽업 1시간 미만 시 10% 수수료)',
  })
  feeMessage: string;

  static from(reservation: Reservation, feeMessage: string): CancelReservationResponseDto {
    return {
      id: Number(reservation.id),
      status: reservation.status,
      feeMessage,
    };
  }
}
