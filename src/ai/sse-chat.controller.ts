import {
  Body,
  Controller,
  HttpCode,
  MessageEvent,
  Post,
  Req,
  RequestMethod,
  Sse,
} from '@nestjs/common';
import { METHOD_METADATA } from '@nestjs/common/constants';
import { ApiBody, ApiOperation, ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import type { Request } from 'express';
import { interval, merge, Observable } from 'rxjs';
import { endWith, ignoreElements, map, share, takeUntil } from 'rxjs/operators';
import { z } from 'zod';
import { AiService } from './ai.service';

const PostSseChatSchema = z
  .object({
    message: z.string().min(1).describe('사용자 질문'),
    userId: z.union([z.number().int(), z.string().min(1)]).optional().describe('로그인 사용자 ID'),
    guestId: z.string().min(1).optional().describe('비로그인 게스트 식별자'),
  })
  .refine((v) => v.userId !== undefined && v.userId !== null && v.userId !== '' ? true : !!v.guestId?.trim(), {
    message: 'userId 또는 guestId 중 하나는 필수입니다.',
  });

class PostSseChatDto extends createZodDto(PostSseChatSchema) {}

function resolveStreamUserId(dto: PostSseChatDto): string {
  if (dto.guestId?.trim()) {
    return `guest:${dto.guestId.trim()}`;
  }
  if (dto.userId !== undefined && dto.userId !== null && dto.userId !== '') {
    return typeof dto.userId === 'number' ? String(dto.userId) : dto.userId.trim();
  }
  throw new Error('userId or guestId required');
}

/** Nest SseStream은 SSE comment(`:`) 줄을 보낼 수 없어 JSON ping으로 연결 유지. */
const HEARTBEAT_INTERVAL_MS = 25_000;

/**
 * POST 본문으로 질문을 보내고, 동일 연결에서 `text/event-stream`으로 status → chat → done 을 수신한다.
 * (`@microsoft/fetch-event-source` 등 POST SSE 클라이언트용)
 */
@ApiTags('sse')
@Controller('sse')
export class SseChatController {
  constructor(private readonly aiService: AiService) {}

  @Post()
  @HttpCode(200)
  @Sse('', { [METHOD_METADATA]: RequestMethod.POST })
  @ApiOperation({
    summary: 'POST SSE — AI 스트림 (한 연결)',
    description:
      '본문에 message와 userId 또는 guestId를 담아 호출하면 200과 함께 text/event-stream으로 ' +
      'status, chat, done(또는 error) 이벤트가 전달됩니다.',
  })
  @ApiBody({ type: PostSseChatDto })
  stream(
    @Body() dto: PostSseChatDto,
    @Req() req: Request,
  ): Observable<MessageEvent> {
    const userKey = resolveStreamUserId(dto);

    const requestAbort = new AbortController();
    const onClose = () => requestAbort.abort();
    req.on('close', onClose);

    const main$ = new Observable<MessageEvent>((subscriber) => {
      void (async () => {
        try {
          await this.aiService.chat(userKey, dto.message, {
            signal: requestAbort.signal,
            streamSink: (ev) => subscriber.next(ev),
          });
          subscriber.complete();
        } catch (e) {
          subscriber.error(e);
        }
      })();
      return () => {
        req.off('close', onClose);
        requestAbort.abort();
      };
    }).pipe(share());

    const heartbeat$ = interval(HEARTBEAT_INTERVAL_MS).pipe(
      map(
        (): MessageEvent => ({
          data: { ping: true, at: Date.now() },
        }),
      ),
      takeUntil(main$.pipe(ignoreElements(), endWith(0))),
    );

    return merge(main$, heartbeat$);
  }
}
