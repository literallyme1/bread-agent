import { HttpException } from '@nestjs/common';
import { ErrorCode, ErrorCodeMeta } from './error-code.enum';

/**
 * 도메인 예외를 HTTP 예외로 변환하는 커스텀 예외 클래스
 * ErrorCode enum을 기반으로 status/message를 자동 매핑
 */
export class CustomException extends HttpException {
  constructor(
    public readonly errorCode: ErrorCode,
    /** 전역 필터가 JSON `data`에 병합해 반환 (예: 세션 status / last_error) */
    public readonly errorPayload?: Record<string, unknown>,
  ) {
    const { status, message } = ErrorCodeMeta[errorCode];
    super(message, status);
  }

  getMessage(): string {
    return ErrorCodeMeta[this.errorCode].message;
  }
}
