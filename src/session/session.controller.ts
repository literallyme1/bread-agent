import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Logger,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiExcludeEndpoint,
  ApiHeader,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import { SessionService, SessionPatchPayload } from './session.service';
import { CurrentSessionSchema, SessionStatusZodSchema } from '../redis/session.schema';
import { ApiResponse, errorSchema } from '../common/dto/api-response.dto';
import { z } from 'zod';

/**
 * Swagger Try it out / 일부 클라이언트가 숫자 필드에 null·""·"123" 문자열을 보내면
 * z.number()가 즉시 실패하고, nestjs-zod는 컨트롤러 진입 전 "Validation failed"만 반환한다.
 * (이 경우 SessionService까지 가지 않아 `[patchSession]` 로그가 남지 않음.)
 */
function patchOptionalInt(intBase: z.ZodNumber) {
  return z.preprocess((v: unknown) => {
    if (v === null || v === undefined || v === '') return undefined;
    if (typeof v === 'string' && /^-?\d+$/.test(v.trim())) return Number(v.trim());
    return v;
  }, intBase.optional());
}

function patchCoerceInt(intBase: z.ZodNumber) {
  return z.preprocess((v: unknown) => {
    if (typeof v === 'string' && /^-?\d+$/.test(v.trim())) return Number(v.trim());
    return v;
  }, intBase);
}

const PatchSelectedItemSchema = z.object({
  id: patchCoerceInt(z.number().int()),
  name: z.string(),
  count: patchCoerceInt(z.number().int().min(1)),
});

// ─── Request DTO — Partial Update / Upsert ───────────────────────────────────

/**
 * PATCH /v1/session/:userId 요청 바디.
 *
 * current_session 필드를 선택적으로 수정합니다(Partial Update / Upsert).
 * 전달된 필드만 기존 세션에 병합되며, 나머지 필드는 그대로 유지됩니다.
 * 세션이 없으면 기본값(SEARCHING)으로 자동 생성 후 병합합니다(Upsert).
 *
 * ※ profile 필드(preferred_station, taste_tags)는 getStores에서 자동 관리되므로 여기서 제외합니다.
 *
 * [서버 자동 처리]
 *   A. last_store_id 전달 시: DB에서 매장명을 조회하여 last_store_name을 자동 채웁니다.
 *      last_store_name만 전달 시: DB에서 매장 ID를 찾아 last_store_id를 자동 채웁니다.
 *   B. selected_items 전달 시: 신규 아이템을 현재 매장 재고와 대조하여 유효성을 검사합니다.
 *   통과 시 저장값: `Z`/offset이 있으면 그대로, 없으면 입력 시각에 `+09:00`만 덧붙임(UTC `toISOString()`으로 바꾸지 않음).
 *   D. 검증 완료 후 last_store_id + selected_items(≥1) + pickup_time 모두 존재 시:
 *      status를 자동으로 READY_FOR_SUMMARY로 승격합니다.
 *
 * [아이템 단위 수정 — itemId + count]
 *   selected_items 배열 전체를 보내는 대신 특정 아이템 ID와 최종 목표 수량(count)을 지정합니다.
 *   count=0이면 해당 아이템을 목록에서 제거합니다.
 *   selected_items와 동시에 사용할 수 없습니다.
 *   수정 결과 selected_items가 비면 status 자동 → SEARCHING, pickup_time/hold_token 초기화.
 */
const PatchSessionSchema = z
  .object({
    // ── current_session 필드 ──────────────────────────────────────────────────
    last_store_id: patchOptionalInt(z.number().int()),
    last_store_name: z.preprocess(
      (v: unknown) => (v === null || v === '' ? undefined : v),
      CurrentSessionSchema.shape.last_store_name,
    ),
    selected_items: z.array(PatchSelectedItemSchema).optional().describe(
      '아이템 목록 전체 교체. itemId와 동시 사용 불가. 각 요소: { id, name, count }',
    ),
    pickup_time: z.preprocess(
      (v: unknown) => (v === null || v === '' ? undefined : v),
      CurrentSessionSchema.shape.pickup_time,
    ),
    hold_token: z.preprocess(
      (v: unknown) => (v === null || v === '' ? undefined : v),
      CurrentSessionSchema.shape.hold_token,
    ),
    status: SessionStatusZodSchema.optional().describe(
      '변경할 예약 상태:\n' +
        '  SEARCHING                      - 예약 정보를 수집 중인 초기 탐색 상태\n' +
        '  READY_FOR_SUMMARY              - 모든 정보 수집 완료 후 최종 요약을 보여주고 사용자 승인을 기다리는 상태\n' +
        '  WAITING_FOR_CONFIRM            - holdReservation 성공(전 아이템 hold) 후 2분 내 확정 대기\n' +
        '  WAITING_FOR_CANCELLING_CONFIRM - 취소 요청 후 수수료 고지, 사용자 최종 동의 대기\n' +
        '  COMPLETED                      - 예약이 성공적으로 확정된 상태\n' +
        '  CANCELLED                      - 예약 취소가 완료된 상태\n' +
        '  FAIL                           - 재고 부족 또는 시스템 오류로 중단된 상태\n' +
        '  EXPIRED                        - Hold TTL 만료로 예약 진행 불가\n' +
        '  ※ itemId + count 사용 시 서버 자동 규칙이 최종 상태를 결정합니다.',
    ),
    // ── 아이템 단위 수정 필드 ──────────────────────────────────────────────────
    itemId: patchOptionalInt(z.number().int().positive()).describe(
      '수정할 아이템 ID. count와 함께 제공해야 합니다. selected_items와 동시 사용 불가.',
    ),
    itemName: z.preprocess(
      (v: unknown) => (v === null || v === '' ? undefined : v),
      z.string().optional(),
    ).describe(
      '추가할 아이템 이름. itemId에 해당하는 아이템이 목록에 없을 때 신규 추가에 사용됩니다.',
    ),
    count: patchOptionalInt(z.number().int().min(0)).describe(
      '아이템의 최종 목표 수량. 0이면 해당 아이템을 목록에서 제거합니다. itemId와 함께 제공해야 합니다.',
    ),
  })
  .refine(
    (data) => !(data.itemId !== undefined && data.selected_items !== undefined),
    { message: 'itemId와 selected_items는 동시에 사용할 수 없습니다.' },
  )
  .refine(
    (data) => (data.itemId === undefined) === (data.count === undefined),
    { message: 'itemId와 count는 반드시 함께 제공해야 합니다.' },
  );

class PatchSessionDto extends createZodDto(PatchSessionSchema) {}

// ─── Swagger 공통 인라인 스키마 ────────────────────────────────────────────────

const SESSION_STATUS_SCHEMA = {
  type: 'string',
  enum: [
    'SEARCHING',
    'READY_FOR_SUMMARY',
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
    '  READY_FOR_SUMMARY - 모든 정보 수집 완료 후 최종 요약을 보여주고 사용자 승인을 기다리는 상태\n' +
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
            last_error: {
              type: 'string',
              example: '일부 상품의 재고가 부족합니다 — 소금빵: 재고 부족 (남은 수량: 1개)',
              nullable: true,
              description:
                '마지막 작업 실패 사유. AI 에이전트가 사용자에게 실패 원인을 설명할 때 참조합니다. ' +
                'FAIL 상태 진입 시 서버가 자동으로 기록하며, 성공 시 삭제됩니다.',
            },
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
   * POST /v1/session/:userId
   */
  @ApiExcludeEndpoint()
  @Post(':userId')
  @HttpCode(HttpStatus.CREATED)
  async createSession(
    @Param('userId') userId: string,
  ) {

    const data = await this.sessionService.createSession(userId);
    return ApiResponse.success(data, 'Session created successfulluserIdy');
  }

  /**
   * PATCH /v1/session/:userId
   */
  @Patch(':userId')
  @ApiOperation({
    operationId: 'patchSession',
    summary: '예약 세션 동기화 — 매장·장바구니·시간 저장 (Upsert)',
    description:
      'AI가 수집한 예약 정보(매장 / 아이템 / 픽업 시간)를 Redis 세션에 저장합니다.\n\n' +
      '전달된 필드만 기존 세션에 병합(Partial Update)하며, 세션이 없으면 자동 생성(Upsert)합니다.\n\n' +
      '**서버 자동 처리 (Side-Effects)**\n' +
      '- [A] `last_store_id` 전달 → DB 조회로 `last_store_name` 자동 채움 (반대도 동일)\n' +
      '- [B] `selected_items` 전달 시 신규 아이템을 현재 매장 재고와 대조하여 유효성 검사\n' +
      '- [C] `pickup_time` — 오프셋 없으면 **KST**로 해석·검증 후, 저장 시 **UTC·Z로 바꾸지 않고** 필요 시 `+09:00`만 덧붙임\n' +
      '- [D] 세션에 `last_store_id` + `selected_items(≥1)` + `pickup_time` 모두 존재하면 `READY_FOR_SUMMARY`로 자동 승격\n\n' +
      '**아이템 단위 수정 — `itemId` + `count`**\n' +
      '`selected_items` 배열 전체 대신 특정 아이템 ID와 최종 목표 수량(count)을 지정합니다.\n' +
      'count=0이면 해당 아이템을 제거합니다.\n\n' +
      '`X-Chat-User-Id` 헤더가 존재하면 path의 userId 대신 해당 값을 사용합니다(AI 호출 보안).',
  })
  @ApiParam({ name: 'userId', type: String, description: '사용자 ID', example: '1' })
  @ApiHeader({
    name: 'X-Chat-User-Id',
    description:
      'AI 도구 호출 시 서버가 자동 주입하는 신뢰 userId. ' +
      '이 헤더가 존재하면 path의 userId를 덮어씁니다(환각/위변조 차단).',
    required: false,
    example: '1',
  })
  @ApiOkResponse({
    description: 'Upsert 성공 — 병합된 세션 전체 반환',
    schema: {
      ...SESSION_RESPONSE_SCHEMA,
      example: {
        data: {
          profile: { preferred_station: '신중동역', taste_tags: ['달지않음', '건강빵'] },
          current_session: {
            last_store_id: 12,
            last_store_name: '하레하레 강남',
            selected_items: [{ id: 101, name: '소금빵', count: 2 }],
            pickup_time: '2026-05-09T20:00:00',
            hold_token: 'h-8291-abc-xyz',
            status: 'WAITING_FOR_CONFIRM',
            last_error: null,
          },
        },
        message: 'Session patched successfully',
      },
    },
  })
  @ApiBadRequestResponse({
    description: '허용되지 않는 필드 값 또는 스키마 검증 실패',
    schema: errorSchema('Session data failed schema validation'),
  })
  async patchSession(
    @Param('userId') userId: string,
    @Body() dto: PatchSessionDto,
    @Headers('x-chat-user-id') trustedUserId?: string,
  ) {
    // AI 도구 호출 시 X-Chat-User-Id 헤더가 주입됨 → 신뢰할 수 있는 userId 사용
    const effectiveUserId = trustedUserId ?? userId;
    this.logger.log(
      `[patchSession] effectiveUserId=${effectiveUserId}` +
        `${trustedUserId ? ' (via X-Chat-User-Id)' : ''} fields=[${Object.keys(dto).join(', ')}]`,
    );
    const data = await this.sessionService.patchSession(effectiveUserId, dto as SessionPatchPayload);
    this.logger.log(`[patchSession] effectiveUserId=${effectiveUserId} done`);
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
