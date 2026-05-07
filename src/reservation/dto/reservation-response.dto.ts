import { Reservation, ReservationStatus } from '../entity/reservation.entity';
import { ReservationItem } from '../entity/reservation-item.entity';

export class ReservationItemResponseDto {
  id: number;
  inventoryId: number;
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
  id: number;
  userId: number;
  status: ReservationStatus;
  pickupTime: Date;
  createdAt: Date;
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
  id: number;
  status: ReservationStatus;
  feeMessage: string;

  static from(reservation: Reservation, feeMessage: string): CancelReservationResponseDto {
    return {
      id: Number(reservation.id),
      status: reservation.status,
      feeMessage,
    };
  }
}
