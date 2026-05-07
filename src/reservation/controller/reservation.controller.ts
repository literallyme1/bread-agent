import { Body, Controller, Get, Param, ParseIntPipe, Post } from '@nestjs/common';
import { ReservationService } from '../service/reservation.service';
import { CreateHoldDto } from '../dto/create-reservation.dto';
import { ConfirmHoldDto } from '../dto/confirm-hold.dto';
import { CancelReservationDto } from '../dto/cancel-reservation.dto';
import { ApiResponse } from '../../common/dto/api-response.dto';

@Controller('v1/reservations')
export class ReservationController {
  constructor(private readonly reservationService: ReservationService) {}

  /**
   * POST /v1/reservations/hold
   * 재고 임시 점유 (Redis Hold, TTL 2분).
   * 아이템별 HELD / OUT_OF_STOCK 결과를 holdToken과 함께 반환.
   */
  @Post('hold')
  async holdReservation(@Body() dto: CreateHoldDto): Promise<ApiResponse<any>> {
    const data = await this.reservationService.holdReservation(dto);
    return ApiResponse.success(data, 'Hold created successfully');
  }

  /**
   * POST /v1/reservations/confirm
   * holdToken 기반으로 Redis Hold → DB Reservation 확정.
   * 재고 차감은 이 단계에서 조건부 UPDATE로 수행.
   */
  @Post('confirm')
  async confirmHold(@Body() dto: ConfirmHoldDto): Promise<ApiResponse<any>> {
    const data = await this.reservationService.confirmHold(dto);
    return ApiResponse.success(data, 'Reservation confirmed successfully');
  }

  /**
   * GET /v1/reservations/:id
   */
  @Get(':id')
  async getReservation(@Param('id', ParseIntPipe) id: number): Promise<ApiResponse<any>> {
    const data = await this.reservationService.getReservation(id);
    return ApiResponse.success(data, 'Reservation fetched successfully');
  }

  /**
   * POST /v1/reservations/:id/cancel
   * 예약 취소 (request body로 userId 전달)
   */
  @Post(':id/cancel')
  async cancelReservation(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: CancelReservationDto,
  ): Promise<ApiResponse<any>> {
    const data = await this.reservationService.cancelReservation(id, dto);
    return ApiResponse.success(data, 'Reservation cancelled successfully');
  }
}
