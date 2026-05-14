import { Body, BadRequestException, Controller, Get, Headers, Logger, Param, ParseIntPipe, Post, Query } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiHeader,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { ReservationService } from '../service/reservation.service';
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
    summary: '재고 임시 hold (Thin API — 요청 바디 없음)',
    description:
      '**요청 바디 없음.** Redis 세션의 `last_store_id`, `selected_items`, `pickup_time`만 사용합니다.\n\n' +
      '**userId**: 쿼리 `userId` 또는 `X-Chat-User-Id` 헤더(우선)로 전달합니다.\n\n' +
      '**필수 세션 필드** — 하나라도 없으면 400:\n' +
      '- `last_store_id`\n' +
      '- `selected_items` (1개 이상)\n' +
      '- `pickup_time`\n\n' +
      '**픽업 시각**: `Z`/`±offset`이 없으면 문자열을 **KST(Asia/Seoul) 벽시각**으로 해석합니다. ' +
      '[현재 − 5초] 이전이면 `예약 가능한 시간이 지났습니다`(400). ' +
      '영업 시간은 픽업 **절대 시각**을 서울 시계로 환산한 시·분으로 판단합니다.\n\n' +
      '**All-or-Nothing**\n' +
      '- 전 아이템 재고 충족 시에만 `holdToken` 발급 + Redis Hold(TTL 2분)\n' +
      '- 실패 시 Hold 미생성, 세션 `FAIL` + `last_error`\n\n' +
      '**성공 시 세션**: `READY_FOR_SUMMARY` 등 → `WAITING_FOR_CONFIRM`, `hold_token` 저장',
  })
  @ApiQuery({
    name: 'userId',
    required: false,
    type: String,
    description:
      '예약 사용자 ID (Redis 세션 키와 동일). `X-Chat-User-Id`가 있으면 쿼리보다 헤더가 우선합니다.',
    example: '1',
  })
  @ApiHeader({
    name: 'X-Chat-User-Id',
    description: 'AI 도구 호출 시 신뢰 userId. 있으면 쿼리 `userId`를 덮어씁니다.',
    required: false,
    example: '1',
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
    description:
      '세션 필수값 누락, userId 누락, 픽업 시각 경과(예약 가능한 시간이 지났습니다), 잘못된 ISO 등',
    schema: errorSchema('Redis 세션에 last_store_id, selected_items(1개 이상), pickup_time이 모두 필요합니다.'),
  })
  @ApiNotFoundResponse({
    description: '사용자 또는 매장 없음',
    schema: errorSchema('Store not found'),
  })
  async holdReservation(
    @Query('userId') userId?: string,
    @Headers('x-chat-user-id') trustedUserId?: string,
  ): Promise<ApiResponse<HoldResponseDto>> {
    const effectiveUserId = (trustedUserId ?? userId)?.trim();
    if (!effectiveUserId) {
      throw new BadRequestException(
        'userId가 필요합니다. 쿼리 ?userId= 또는 X-Chat-User-Id 헤더를 사용하세요.',
      );
    }
    this.logger.log(`[holdReservation] userId=${effectiveUserId}${trustedUserId ? ' (via X-Chat-User-Id)' : ''}`);
    const data = await this.reservationService.holdReservation(effectiveUserId);
    this.logger.log(
      `[holdReservation] userId=${effectiveUserId} success=${data.success} holdToken=${data.holdToken}`,
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
      '**Hold 만료 / 세션에 hold_token 없음** — Redis 세션을 `READY_FOR_SUMMARY`로 되돌리고 `last_error`를 설정한 뒤 `400` + `HOLD_EXPIRED`(응답 `data`에 `status`, `last_error`, `errorCode`)를 반환합니다. `holdReservation`으로 재시도할 수 있습니다.\n\n' +
      '**Side-Effects (성공 시)**\n' +
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
  @ApiBadRequestResponse({
    description: 'hold TTL 만료 또는 세션에 hold_token 없음 — 세션 READY_FOR_SUMMARY 강등, data에 status·last_error·errorCode',
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
