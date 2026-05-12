import { ApiProperty } from '@nestjs/swagger';
import { Reservation, ReservationStatus } from '../entity/reservation.entity';
import { ReservationItem } from '../entity/reservation-item.entity';
import { HoldData } from '../../redis/redis.service';
import { Store } from '../../store/entity/store.entity';

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

/**
 * 확정된 예약의 매장 요약 정보.
 * AI가 인사 메시지를 구성할 때 사용합니다.
 */
export class ConfirmedStoreDto {
  @ApiProperty({ example: 5, description: '매장 ID' })
  id: number;

  @ApiProperty({ example: '하레하레 강남', description: '매장 이름' })
  name: string;

  @ApiProperty({ example: '강남역', description: '인근 지하철역' })
  station: string;

  @ApiProperty({ example: '서울 강남구 강남대로 100', description: '매장 주소' })
  address: string;
}

/**
 * 확정된 예약의 빵 아이템 요약.
 */
export class ConfirmedItemDto {
  @ApiProperty({ example: 101, description: '빵 ID' })
  breadId: number;

  @ApiProperty({ example: '소금빵', description: '빵 이름' })
  breadName: string;

  @ApiProperty({ example: 2, description: '예약 수량' })
  qty: number;
}

/**
 * POST /v1/reservations/confirm 성공 응답.
 *
 * ReservationResponseDto보다 풍부한 정보를 포함합니다.
 * AI가 이 데이터를 참조하여 예약 완료 인사 메시지를 구성합니다.
 */
export class ConfirmReservationResponseDto {
  @ApiProperty({ example: 42, description: '예약 ID' })
  reservationId: number;

  @ApiProperty({ example: 1, description: '사용자 ID' })
  userId: number;

  @ApiProperty({ example: 'CONFIRMED', description: '예약 상태' })
  status: 'CONFIRMED';

  @ApiProperty({ type: ConfirmedStoreDto })
  store: ConfirmedStoreDto;

  @ApiProperty({ type: [ConfirmedItemDto] })
  items: ConfirmedItemDto[];

  @ApiProperty({ example: '2026-05-09T20:00:00.000Z', description: '픽업 예정 시각 (ISO 8601)' })
  pickupTime: string;

  @ApiProperty({ example: '2026-05-09T10:00:00.000Z', description: '예약 생성 시각 (ISO 8601)' })
  createdAt: string;

  static from(
    reservation: Reservation,
    holdData: HoldData,
    store: Store,
  ): ConfirmReservationResponseDto {
    return {
      reservationId: Number(reservation.id),
      userId: Number(reservation.userId),
      status: 'CONFIRMED',
      store: {
        id: store.id,
        name: store.name,
        station: store.station,
        address: store.address,
      },
      items: holdData.items.map((item) => ({
        breadId: item.breadId,
        breadName: item.breadName,
        qty: item.heldQty,
      })),
      pickupTime: holdData.pickupTime,
      createdAt: reservation.createdAt.toISOString(),
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
