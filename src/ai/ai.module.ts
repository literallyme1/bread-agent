import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { SseModule } from '../sse/sse.module';
import { AiController } from './ai.controller';
import { AiService } from './ai.service';
import { SseChatController } from './sse-chat.controller';

@Module({
  imports: [ConfigModule, SseModule],
  controllers: [AiController, SseChatController],
  providers: [AiService],
  exports: [AiService],
})
export class AiModule {}
