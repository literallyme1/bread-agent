import { Controller, MessageEvent, Param, Sse } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { Observable } from 'rxjs';
import { SseService } from './sse.service';

@ApiTags('sse')
@Controller('sse')
export class SseController {
  constructor(private readonly sse: SseService) {}

  @Sse('stream/:userId')
  @ApiOperation({ summary: 'userId 기반 SSE 스트림 (SseService.emitEvent로 푸시)' })
  @ApiParam({ name: 'userId', description: '사용자 식별자' })
  stream(@Param('userId') userId: string): Observable<MessageEvent> {
    return this.sse.connect(userId);
  }
}
