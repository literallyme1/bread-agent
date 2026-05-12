import { Body, Controller, Get, Logger, Param, ParseIntPipe, Post, Query } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiGoneResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { ReservationService } from '../service/reservation.service';
import { CreateHoldDto } from '../dto/create-reservation.dto';
import { ConfirmHoldDto } from '../dto/confirm-hold.dto';
import { CancelReservationDto } from '../dto/cancel-reservation.dto';
import { HoldResponseDto } from '../dto/hold-response.dto';
import {
  CancelReservationResponseDto,
  ConfirmReservationResponseDto,
  ReservationResponseDto,
} from '../dto/reservation-response.dto';
import {
  ReservationListEntry,
  ReservationListQueryDto,
} from '../dto/reservation-list.dto';
import { ApiResponse, errorSchema } from '../../common/dto/api-response.dto';

@ApiTags('Reservations')
@Controller('v1/reservations')
export class ReservationController {
  private readonly logger = new Logger(ReservationController.name);

  constructor(private readonly reservationService: ReservationService) {}

  /**
   * POST /v1/reservations/hold
   */
  @Post('hold')
  @ApiOperation({
    operationId: 'holdReservation',
    summary: '재고 임시 hold 생성 (All-or-Nothing)',
    description:
      '픽업 시각 검증 → 전체 아이템 재고 확인 → All-or-Nothing 방식으로 Redis Hold 저장 (TTL 2분).\n\n' +
      '**All-or-Nothing 규칙**\n' +
      '- 요청한 모든 아이템의 재고가 충분할 때만 holdToken을 발급하고 Redis에 Hold를 생성합니다.\n' +
      '- 단 하나라도 재고 부족이면 Redis Hold를 생성하지 않고 `success: false`와 상세 실패 목록을 반환합니다.\n\n' +
      '**세션 상태 전이**\n' +
      '- 성공: `READY_FOR_SUMMARY → WAITING_FOR_CONFIRM` (hold_token 함께 저장)\n' +
      '- 실패: 현재 상태 → `FAIL` (last_error에 실패 사유 기록)\n\n' +
      '실제 재고 차감은 `/confirm` 단계에서만 수행됩니다.',
  })
  @ApiCreatedResponse({
    description: '전체 hold 성공 — holdToken 발급',
    schema: {
      example: {
        data: {
          success: true,
          holdToken: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
          items: [
            { id: '101', name: '소금빵', requestedCount: 2, heldCount: 2, status: 'SUCCESS' },
            { id: '202', name: '크림빵', requestedCount: 1, heldCount: 1, status: 'SUCCESS' },
          ],
        },
        message: 'Hold created successfully',
      },
    },
  })
  @ApiOkResponse({
    description: '일부 또는 전체 재고 부족 — holdToken 미발급 (success: false)',
    schema: {
      example: {
        data: {
          success: false,
          holdToken: null,
          items: [
            { id: '101', name: '소금빵', requestedCount: 2, heldCount: 2, status: 'SUCCESS' },
            {
              id: '202',
              name: '고구마빵',
              requestedCount: 3,
              heldCount: 0,
              status: 'OUT_OF_STOCK',
              reason: '재고 부족 (남은 수량: 1개)',
            },
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
    this.logger.log(
      `[holdReservation] userId=${dto.userId} storeId=${dto.storeId}` +
        ` items=${dto.items.length} pickupTime=${dto.pickupTime}`,
    );
    const data = await this.reservationService.holdReservation(dto);
    this.logger.log(
      `[holdReservation] userId=${dto.userId} success=${data.success} holdToken=${data.holdToken}`,
    );
    return ApiResponse.success(data, 'Hold created successfully');
  }

  /**
   * POST /v1/reservations/confirm
   */
  @Post('confirm')
  @ApiOperation({
    operationId: 'confirmReservation',
    summary: 'Hold 확정 → 예약 생성',
    description:
      'holdToken 기반으로 Redis Hold를 조회하고 DB에 예약을 확정합니다. ' +
      '재고 차감은 이 단계에서 조건부 UPDATE(동시성 안전)로 수행됩니다.\n\n' +
      '**Side-Effects**\n' +
      '- Redis Hold 삭제\n' +
      '- Redis 세션 전체 삭제 (AI 인사 후 다음 예약을 위해 완전 초기화)\n\n' +
      '응답에 매장 이름·위치, 아이템 이름·수량, 픽업 시각이 포함되어 ' +
      'AI가 예약 완료 인사 메시지를 바로 구성할 수 있습니다.',
  })
  @ApiOkResponse({
    description: '예약 확정 성공',
    schema: {
      example: {
        data: {
          reservationId: 42,
          userId: 1,
          status: 'CONFIRMED',
          store: {
            id: 5,
            name: '하레하레 강남',
            station: '강남역',
            address: '서울 강남구 강남대로 100',
          },
          items: [
            { breadId: 101, breadName: '소금빵', qty: 2 },
            { breadId: 202, breadName: '크림빵', qty: 1 },
          ],
          pickupTime: '2026-05-09T20:00:00.000Z',
          createdAt: '2026-05-09T10:00:00.000Z',
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
  async confirmHold(@Body() dto: ConfirmHoldDto): Promise<ApiResponse<ConfirmReservationResponseDto>> {
    this.logger.log(`[confirmHold] userId=${dto.userId} holdToken=${dto.holdToken}`);
    const data = await this.reservationService.confirmHold(dto);
    this.logger.log(`[confirmHold] userId=${dto.userId} reservationId=${data.reservationId} store="${data.store.name}"`);
    return ApiResponse.success(data, 'Reservation confirmed successfully');
  }

  /**
   * GET /v1/reservations
   * 취소 가능한 미래 예약 목록 조회 (서버 지능형 필터 적용)
   */
  @Get()
  @ApiOperation({
    operationId: 'listReservations',
    summary: '취소 가능한 미래 예약 목록 조회',
    description:
      'userId 기준으로 취소 가능한 미래 예약을 조회합니다.\n\n' +
      '**서버 자동 필터**\n' +
      '- status = CONFIRMED (확정된 예약만)\n' +
      '- pickupTime > 현재 시각 (미래 픽업만)\n\n' +
      '**Side-Effect**: 취소 가능한 예약이 1건 이상 존재하면 ' +
      'Redis 세션을 `WAITING_FOR_CANCELLING_CONFIRM`으로 자동 전이합니다. ' +
      'AI는 이 상태를 확인하고 취소 동의 흐름을 시작합니다.',
  })
  @ApiQuery({
    name: 'userId',
    type: Number,
    description: '조회할 사용자 ID',
    example: 1,
  })
  @ApiOkResponse({
    description: '예약 목록 반환 성공',
    schema: {
      properties: {
        data: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'integer', example: 1, description: '예약 ID' },
              userId: { type: 'integer', example: 1, description: '사용자 ID' },
              status: {
                type: 'string',
                enum: ['CONFIRMED', 'CANCELLED'],
                example: 'CONFIRMED',
                description: '예약 상태 (CONFIRMED: 확정 | CANCELLED: 취소)',
              },
              pickupTime: {
                type: 'string',
                example: '2026-05-08T14:00:00.000Z',
                description: '픽업 예정 시각 (ISO 8601)',
              },
              createdAt: {
                type: 'string',
                example: '2026-05-07T10:00:00.000Z',
                description: '예약 생성 시각 (ISO 8601)',
              },
              items: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    id: { type: 'integer', example: 1, description: '예약 아이템 ID' },
                    inventoryId: { type: 'integer', example: 10, description: '재고 ID' },
                    qty: { type: 'integer', example: 2, description: '예약 수량' },
                  },
                },
              },
            },
          },
        },
        message: { type: 'string', example: 'Reservations fetched successfully' },
      },
      example: {
        data: [
          {
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
        ],
        message: 'Reservations fetched successfully',
      },
    },
  })
  @ApiBadRequestResponse({
    description: '잘못된 쿼리 파라미터 (userId 미입력, status 범위 오류 등)',
    schema: errorSchema('Validation failed'),
  })
  async listReservations(
    @Query() query: ReservationListQueryDto,
  ): Promise<ApiResponse<ReservationListEntry[]>> {
    this.logger.log(`[listReservations] userId=${query.userId}`);
    const data = await this.reservationService.getReservationList(query.userId);
    this.logger.log(`[listReservations] userId=${query.userId} cancellable=${data.length}`);
    return ApiResponse.success(data, 'Reservations fetched successfully');
  }

  /**
   * GET /v1/reservations/:id
   */
  @Get(':id')
  @ApiOperation({ operationId: 'findReservation', summary: '예약 단건 조회' })
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
    this.logger.log(`[getReservation] id=${id}`);
    const data = await this.reservationService.getReservation(id);
    this.logger.log(`[getReservation] id=${id} status=${data.status}`);
    return ApiResponse.success(data, 'Reservation fetched successfully');
  }

  /**
   * POST /v1/reservations/:id/cancel
   */
  @Post(':id/cancel')
  @ApiOperation({
    operationId: 'cancelReservation',
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
    this.logger.log(`[cancelReservation] id=${id} userId=${dto.userId}`);
    const data = await this.reservationService.cancelReservation(id, dto);
    this.logger.log(`[cancelReservation] id=${id} status=${data.status} feeMessage="${data.feeMessage}"`);
    return ApiResponse.success(data, 'Reservation cancelled successfully');
  }
}
