import { Reservation, ReservationStatus } from './reservation.entity';
import { ReservationItem } from './reservation-item.entity';

/**
 * Reservation 도메인 엔티티 단위 테스트
 * 상태 전이 규칙과 수수료 판단 로직 검증
 */
describe('Reservation Entity', () => {
  const buildReservation = (overrides: Partial<Reservation> = {}): Reservation => {
    const res = new Reservation();
    res.id = 1;
    res.userId = 1;
    res.status = ReservationStatus.CONFIRMED;
    res.pickupTime = new Date(Date.now() + 3600 * 1000 * 3);
    res.createdAt = new Date();
    res.items = [];
    return Object.assign(res, overrides);
  };

  describe('cancel()', () => {
    it('CONFIRMED 상태 예약을 취소하면 CANCELLED로 전이', () => {
      const reservation = buildReservation();
      reservation.cancel();
      expect(reservation.status).toBe(ReservationStatus.CANCELLED);
    });

    it('이미 CANCELLED 상태에서 cancel() 호출 시 예외 발생', () => {
      const reservation = buildReservation({ status: ReservationStatus.CANCELLED });
      expect(() => reservation.cancel()).toThrow('ALREADY_CANCELLED');
    });
  });

  describe('isWithinOneHourOfPickup()', () => {
    it('pickup까지 2시간 남으면 false (수수료 없음)', () => {
      const reservation = buildReservation({
        pickupTime: new Date(Date.now() + 2 * 3600 * 1000),
      });
      expect(reservation.isWithinOneHourOfPickup()).toBe(false);
    });

    it('pickup까지 30분 남으면 true (수수료 부과)', () => {
      const reservation = buildReservation({
        pickupTime: new Date(Date.now() + 30 * 60 * 1000),
      });
      expect(reservation.isWithinOneHourOfPickup()).toBe(true);
    });

    it('pickup 시간이 지났으면 true (수수료 부과)', () => {
      const reservation = buildReservation({
        pickupTime: new Date(Date.now() - 1000),
      });
      expect(reservation.isWithinOneHourOfPickup()).toBe(true);
    });
  });
});
