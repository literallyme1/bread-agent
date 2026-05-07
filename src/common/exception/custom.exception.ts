import { HttpException } from '@nestjs/common';
import { ErrorCode, ErrorCodeMeta } from './error-code.enum';

/**
 * 도메인 예외를 HTTP 예외로 변환하는 커스텀 예외 클래스
 * ErrorCode enum을 기반으로 status/message를 자동 매핑
 */
export class CustomException extends HttpException {
  constructor(public readonly errorCode: ErrorCode) {
    const { status, message } = ErrorCodeMeta[errorCode];
    super(message, status);
  }

  getMessage(): string {
    return ErrorCodeMeta[this.errorCode].message;
  }
}
