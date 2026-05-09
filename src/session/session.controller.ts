import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Logger,
  Param,
  Patch,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import { SessionService } from './session.service';
import { CurrentSessionSchema, SelectedItemSchema, SessionStatusZodSchema } from '../redis/session.schema';
import { ApiResponse, errorSchema } from '../common/dto/api-response.dto';
import { z } from 'zod';

// ─── Request DTO — Partial Update ────────────────────────────────────────────

/**
 * PATCH /v1/session/:userId 요청 바디.
 * CurrentSession의 모든 필드가 optional이므로, 전달된 필드만 기존 세션에 병합됩니다.
 */
const PatchSessionSchema = z.object({
  last_store_id: CurrentSessionSchema.shape.last_store_id,
  last_store_name: CurrentSessionSchema.shape.last_store_name,
  selected_items: z.array(SelectedItemSchema).optional().describe(
    '선택한 아이템 목록 ({ id, name, count } 배열)',
  ),
  pickup_time: CurrentSessionSchema.shape.pickup_time,
  hold_token: CurrentSessionSchema.shape.hold_token,
  status: SessionStatusZodSchema.optional().describe(
    '변경할 예약 상태:\n' +
      '  SEARCHING                      - 예약 정보를 수집 중인 초기 탐색 상태\n' +
      '  PRE_HOLD_CONFIRM               - 모든 정보가 수집되어 사용자에게 최종 확인을 구하는 상태\n' +
      '  WAITING_FOR_CONFIRM            - holdReservation 성공(전 아이템 hold) 후 2분 내 확정 대기\n' +
      '  WAITING_FOR_CANCELLING_CONFIRM - 취소 요청 후 수수료 고지, 사용자 최종 동의 대기\n' +
      '  COMPLETED                      - 예약이 성공적으로 확정된 상태\n' +
      '  CANCELLED                      - 예약 취소가 완료된 상태\n' +
      '  FAIL                           - 재고 부족 또는 시스템 오류로 중단된 상태\n' +
      '  EXPIRED                        - Hold TTL 만료로 예약 진행 불가',
  ),
});

class PatchSessionDto extends createZodDto(PatchSessionSchema) {}

// ─── Swagger 공통 인라인 스키마 ────────────────────────────────────────────────

const SESSION_STATUS_SCHEMA = {
  type: 'string',
  enum: [
    'SEARCHING',
    'PRE_HOLD_CONFIRM',
    'WAITING_FOR_CONFIRM',
    'WAITING_FOR_CANCELLING_CONFIRM',
    'COMPLETED',
    'CANCELLED',
    'FAIL',
    'EXPIRED',
  ],
  example: 'WAITING_FOR_CONFIRM',
  description:
    'Redis 세션 예약 상태 (DB ReservationStatus와 분리된 세션 전용 상태값):\n' +
    '  SEARCHING - 예약 정보를 수집 중인 초기 탐색 상태\n' +
    '  PRE_HOLD_CONFIRM - 모든 정보가 수집되어 사용자에게 최종 확인을 구하는 상태\n' +
    '  WAITING_FOR_CONFIRM - holdReservation 성공 후 2분 내 최종 확정 대기\n' +
    '  WAITING_FOR_CANCELLING_CONFIRM - 취소 요청 후 수수료 고지, 사용자 최종 동의 대기\n' +
    '  COMPLETED - 예약이 성공적으로 확정된 상태\n' +
    '  CANCELLED - 예약 취소가 완료된 상태\n' +
    '  FAIL - 재고 부족 또는 시스템 오류로 중단된 상태\n' +
    '  EXPIRED - Hold TTL 만료로 인해 예약을 진행할 수 없는 상태',
};

const SESSION_RESPONSE_SCHEMA = {
  properties: {
    data: {
      type: 'object',
      properties: {
        profile: {
          type: 'object',
          nullable: true,
          description: '사용자 선호 프로필',
          properties: {
            preferred_station: {
              type: 'string',
              example: '신중동역',
              description: '선호 지역(역명). 특정 역명을 강제하지 않으며 동적으로 관리됩니다.',
            },
            taste_tags: {
              type: 'array',
              items: { type: 'string' },
              example: ['달지않음', '건강빵'],
              description: '취향 태그 배열',
            },
          },
        },
        current_session: {
          type: 'object',
          nullable: true,
          description: '예약 진행을 위한 실시간 세션 데이터',
          properties: {
            last_store_id: {
              type: 'integer',
              example: 12,
              nullable: true,
              description: '마지막으로 선택한 매장 ID (매장 선택 시점부터 저장)',
            },
            last_store_name: {
              type: 'string',
              example: '하레하레 강남',
              nullable: true,
              description: '마지막으로 선택한 매장 이름 (매장 선택 시점부터 저장)',
            },
            selected_items: {
              type: 'array',
              nullable: true,
              description: '선택한 아이템 목록',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'integer', example: 101, description: '빵/메뉴 ID' },
                  name: { type: 'string', example: '소금빵', description: '빵/메뉴 이름' },
                  count: { type: 'integer', example: 2, description: '수량 (1 이상)' },
                },
              },
            },
            pickup_time: {
              type: 'string',
              example: '2026-05-09T20:00:00',
              nullable: true,
              description: '픽업 예정 시각 (ISO 8601)',
            },
            hold_token: {
              type: 'string',
              example: 'h-8291-abc-xyz',
              nullable: true,
              description: '서버에서 발급한 임시 점유 토큰',
            },
            status: SESSION_STATUS_SCHEMA,
          },
        },
      },
    },
    message: { type: 'string', example: 'Session fetched successfully' },
  },
  example: {
    data: {
      profile: {
        preferred_station: '신중동역',
        taste_tags: ['달지않음', '건강빵'],
      },
      current_session: {
        last_store_id: 12,
        last_store_name: '하레하레 강남',
        selected_items: [{ id: 101, name: '소금빵', count: 2 }],
        pickup_time: '2026-05-09T20:00:00',
        hold_token: 'h-8291-abc-xyz',
        status: 'WAITING_FOR_CONFIRM',
      },
    },
    message: 'Session fetched successfully',
  },
};

// ─── Controller ───────────────────────────────────────────────────────────────

@ApiTags('Session')
@Controller('v1/session')
export class SessionController {
  private readonly logger = new Logger(SessionController.name);

  constructor(private readonly sessionService: SessionService) {}

  /**
   * GET /v1/session/:userId
   */
  @Get(':userId')
  @ApiOperation({
    operationId: 'getSession',
    summary: '사용자 Redis 세션 조회',
    description:
      '특정 사용자의 전체 Redis 세션 데이터(Profile + CurrentSession)를 반환합니다. ' +
      '세션이 존재하지 않으면 404를 반환합니다.',
  })
  @ApiParam({ name: 'userId', type: String, description: '사용자 ID', example: '1' })
  @ApiOkResponse({
    description: '세션 조회 성공',
    schema: SESSION_RESPONSE_SCHEMA,
  })
  @ApiNotFoundResponse({
    description: '세션 없음',
    schema: errorSchema('Session not found for userId: 1'),
  })
  async getSession(@Param('userId') userId: string) {
    this.logger.log(`[getSession] userId=${userId}`);
    const data = await this.sessionService.getSession(userId);
    return ApiResponse.success(data, 'Session fetched successfully');
  }

  /**
   * PATCH /v1/session/:userId
   */
  @Patch(':userId')
  @ApiOperation({
    operationId: 'patchSession',
    summary: 'current_session Partial Update',
    description:
      'Body에 포함된 필드만 기존 current_session에 병합합니다(Partial Update). ' +
      '포함되지 않은 필드는 기존 값을 그대로 유지합니다. ' +
      'AI 에이전트가 의도에 따라 상태를 전이하거나 특정 세션 필드를 변경할 때 사용합니다. ' +
      '저장 전 RedisUserSessionSchema.safeParse()로 런타임 검증을 수행합니다.',
  })
  @ApiParam({ name: 'userId', type: String, description: '사용자 ID', example: '1' })
  @ApiOkResponse({
    description: 'Partial Update 성공 — 병합된 세션 전체 반환',
    schema: {
      ...SESSION_RESPONSE_SCHEMA,
      example: {
        data: {
          profile: { preferred_station: '신중동역', taste_tags: ['달지않음'] },
          current_session: {
            last_store_id: 12,
            last_store_name: '하레하레 강남',
            selected_items: [{ id: 101, name: '소금빵', count: 2 }],
            pickup_time: '2026-05-09T20:00:00',
            hold_token: 'h-8291-abc-xyz',
            status: 'PRE_HOLD_CONFIRM',
          },
        },
        message: 'Session patched successfully',
      },
    },
  })
  @ApiNotFoundResponse({
    description: '세션 없음',
    schema: errorSchema('Session not found for userId: 1'),
  })
  @ApiBadRequestResponse({
    description: '허용되지 않는 필드 값 또는 스키마 검증 실패',
    schema: errorSchema('Session data failed schema validation'),
  })
  async patchSession(
    @Param('userId') userId: string,
    @Body() dto: PatchSessionDto,
  ) {
    this.logger.log(`[patchSession] userId=${userId} fields=[${Object.keys(dto).join(', ')}]`);
    const data = await this.sessionService.patchSession(userId, dto);
    this.logger.log(`[patchSession] userId=${userId} done`);
    return ApiResponse.success(data, 'Session patched successfully');
  }

  /**
   * DELETE /v1/session/:userId
   */
  @Delete(':userId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    operationId: 'deleteSession',
    summary: '사용자 Redis 세션 삭제',
    description:
      '세션 만료 또는 예약 취소 시 해당 사용자의 Redis 데이터를 완전히 삭제합니다. ' +
      '세션이 존재하지 않으면 404를 반환합니다.',
  })
  @ApiParam({ name: 'userId', type: String, description: '사용자 ID', example: '1' })
  @ApiNoContentResponse({ description: '세션 삭제 성공 (응답 바디 없음)' })
  @ApiNotFoundResponse({
    description: '세션 없음',
    schema: errorSchema('Session not found for userId: 1'),
  })
  async deleteSession(@Param('userId') userId: string): Promise<void> {
    this.logger.log(`[deleteSession] userId=${userId}`);
    await this.sessionService.deleteSession(userId);
  }
}
