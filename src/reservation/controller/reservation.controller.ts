import { Body, Controller, Get, Param, ParseIntPipe, Post } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiGoneResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { ReservationService } from '../service/reservation.service';
import { CreateHoldDto } from '../dto/create-reservation.dto';
import { ConfirmHoldDto } from '../dto/confirm-hold.dto';
import { CancelReservationDto } from '../dto/cancel-reservation.dto';
import { HoldResponseDto } from '../dto/hold-response.dto';
import {
  CancelReservationResponseDto,
  ReservationResponseDto,
} from '../dto/reservation-response.dto';
import { ApiResponse, errorSchema } from '../../common/dto/api-response.dto';

@ApiTags('Reservations')
@Controller('v1/reservations')
export class ReservationController {
  constructor(private readonly reservationService: ReservationService) {}

  /**
   * POST /v1/reservations/hold
   */
  @Post('hold')
  @ApiOperation({
    summary: '재고 임시 hold 생성',
    description:
      '픽업 시각 검증 → 재고 확인 → Redis에 holdToken 저장 (TTL 2분). ' +
      '재고가 있는 아이템만 HELD, 부족한 아이템은 OUT_OF_STOCK으로 반환합니다. ' +
      '실제 재고 차감은 /confirm 단계에서 수행됩니다.',
  })
  @ApiOkResponse({
    description: 'Hold 생성 성공',
    schema: {
      example: {
        data: {
          holdToken: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
          items: [
            { breadName: '소금빵', requestedQty: 2, heldQty: 2, status: 'HELD' },
            { breadName: '고구마빵', requestedQty: 3, heldQty: 0, status: 'OUT_OF_STOCK' },
          ],
        },
        message: 'Hold created successfully',
      },
    },
  })
  @ApiBadRequestResponse({
    description: '잘못된 픽업 시각 또는 영업시간 외',
    schema: errorSchema('Pickup time must be a valid future datetime'),
  })
  @ApiNotFoundResponse({
    description: '사용자 또는 매장 없음',
    schema: errorSchema('Store not found'),
  })
  async holdReservation(@Body() dto: CreateHoldDto): Promise<ApiResponse<HoldResponseDto>> {
    const data = await this.reservationService.holdReservation(dto);
    return ApiResponse.success(data, 'Hold created successfully');
  }

  /**
   * POST /v1/reservations/confirm
   */
  @Post('confirm')
  @ApiOperation({
    summary: 'Hold 확정 → 예약 생성',
    description:
      'holdToken 기반으로 Redis Hold를 조회하고 DB에 예약을 확정합니다. ' +
      '재고 차감은 이 단계에서 조건부 UPDATE(동시성 안전)로 수행됩니다. ' +
      '확정 후 Redis Hold는 삭제됩니다.',
  })
  @ApiOkResponse({
    description: '예약 확정 성공',
    schema: {
      example: {
        data: {
          id: 1,
          userId: 1,
          status: 'CONFIRMED',
          pickupTime: '2026-05-08T14:00:00.000Z',
          createdAt: '2026-05-07T10:00:00.000Z',
          items: [
            { id: 1, inventoryId: 10, qty: 2 },
            { id: 2, inventoryId: 20, qty: 1 },
          ],
        },
        message: 'Reservation confirmed successfully',
      },
    },
  })
  @ApiNotFoundResponse({
    description: 'holdToken 없음 또는 만료',
    schema: errorSchema('Hold not found or already expired'),
  })
  @ApiConflictResponse({
    description: '재고 부족 (confirm 시점 재확인)',
    schema: errorSchema('Out of stock'),
  })
  @ApiGoneResponse({
    description: 'hold TTL 만료',
    schema: errorSchema('Hold token has expired'),
  })
  async confirmHold(@Body() dto: ConfirmHoldDto): Promise<ApiResponse<ReservationResponseDto>> {
    const data = await this.reservationService.confirmHold(dto);
    return ApiResponse.success(data, 'Reservation confirmed successfully');
  }

  /**
   * GET /v1/reservations/:id
   */
  @Get(':id')
  @ApiOperation({ summary: '예약 단건 조회' })
  @ApiOkResponse({
    description: '예약 정보',
    schema: {
      example: {
        data: {
          id: 1,
          userId: 1,
          status: 'CONFIRMED',
          pickupTime: '2026-05-08T14:00:00.000Z',
          createdAt: '2026-05-07T10:00:00.000Z',
          items: [{ id: 1, inventoryId: 10, qty: 2 }],
        },
        message: 'Reservation fetched successfully',
      },
    },
  })
  @ApiNotFoundResponse({
    description: '예약 없음',
    schema: errorSchema('Reservation not found'),
  })
  async getReservation(
    @Param('id', ParseIntPipe) id: number,
  ): Promise<ApiResponse<ReservationResponseDto>> {
    const data = await this.reservationService.getReservation(id);
    return ApiResponse.success(data, 'Reservation fetched successfully');
  }

  /**
   * POST /v1/reservations/:id/cancel
   */
  @Post(':id/cancel')
  @ApiOperation({
    summary: '예약 취소',
    description:
      'userId 권한 검증 후 CANCELLED 상태로 변경합니다. ' +
      '픽업 1시간 미만 남은 경우 10% 취소 수수료 메시지를 반환합니다. ' +
      '취소 시 재고가 자동으로 복구됩니다.',
  })
  @ApiOkResponse({
    description: '취소 성공',
    schema: {
      example: {
        data: {
          id: 1,
          status: 'CANCELLED',
          feeMessage: '전액 환불됩니다.',
        },
        message: 'Reservation cancelled successfully',
      },
    },
  })
  @ApiNotFoundResponse({
    description: '예약 없음',
    schema: errorSchema('Reservation not found'),
  })
  @ApiBadRequestResponse({
    description: '이미 취소된 예약',
    schema: errorSchema('Reservation already cancelled'),
  })
  async cancelReservation(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: CancelReservationDto,
  ): Promise<ApiResponse<CancelReservationResponseDto>> {
    const data = await this.reservationService.cancelReservation(id, dto);
    return ApiResponse.success(data, 'Reservation cancelled successfully');
  }
}
