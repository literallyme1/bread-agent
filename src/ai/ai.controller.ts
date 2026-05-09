import { Body, Controller, Logger, Post } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { AiService } from './ai.service';
import { ApiResponse } from '../common/dto/api-response.dto';

const ChatRequestSchema = z.object({
  userId: z.number().int().describe('요청 사용자 ID'),
  message: z.string().min(1).describe('AI 에이전트에게 전달할 메시지'),
});

class ChatRequestDto extends createZodDto(ChatRequestSchema) {}

@ApiTags('AI')
@Controller('v1/ai')
export class AiController {
  private readonly logger = new Logger(AiController.name);

  constructor(private readonly aiService: AiService) {}

  @Post('chat')
  @ApiOperation({
    operationId: 'aiChat',
    summary: 'AI 에이전트 대화',
    description:
      'Bread-Path AI 에이전트에게 메시지를 전송하고 응답을 받습니다. ' +
      '에이전트는 매장 조회·재고 확인·예약 등의 API를 자율적으로 호출하여 답변합니다.',
  })
  @ApiOkResponse({
    description: 'AI 응답 반환',
    schema: {
      example: {
        data: { reply: '강남역 근처 소금빵 재고가 있는 매장을 찾았습니다. ...' },
        message: 'OK',
      },
    },
  })
  async chat(@Body() dto: ChatRequestDto): Promise<ApiResponse<{ reply: string }>> {
    this.logger.log(`[chat] userId=${dto.userId} message="${dto.message}"`);

    const reply = await this.aiService.chat(String(dto.userId), dto.message);

    this.logger.log(`[chat] userId=${dto.userId} reply.length=${reply.length}`);
    return ApiResponse.success({ reply }, 'OK');
  }
}
