import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Response } from 'express';
import { CustomException } from '../exception/custom.exception';
import { ApiResponse } from '../dto/api-response.dto';

/**
 * 전역 예외 핸들러
 * CustomException은 `errorPayload`가 있으면 `data`에 `errorCode`와 함께 반환합니다.
 * 그 외 HttpException / 알 수 없는 예외는 { data: null, message } 형태로 응답합니다.
 */
@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(GlobalExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let message = 'Internal server error';

    if (exception instanceof CustomException) {
      status = exception.getStatus();
      message = exception.getMessage();
      const data =
        exception.errorPayload != null
          ? { errorCode: exception.errorCode, ...exception.errorPayload }
          : null;
      response.status(status).json({ data, message });
      return;
    } else if (exception instanceof HttpException) {
      status = exception.getStatus();
      const res = exception.getResponse();
      // class-validator의 ValidationPipe가 반환하는 배열 메시지 처리
      if (typeof res === 'string') {
        message = res;
      } else if (Array.isArray((res as any).message)) {
        message = (res as any).message[0];
      } else {
        message = (res as any).message ?? message;
      }
    } else {
      this.logger.error('Unhandled exception', exception instanceof Error ? exception.stack : exception);
    }

    response.status(status).json(ApiResponse.error(message));
    return;
  }
}
