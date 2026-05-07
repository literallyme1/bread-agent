/**
 * 모든 API 응답에 공통으로 사용되는 래퍼 클래스.
 * 제네릭 T는 런타임 전용이므로 @ApiProperty를 달지 않습니다.
 * Swagger 문서화는 각 컨트롤러의 @ApiOkResponse(schema: { example }) 로 처리합니다.
 */
export class ApiResponse<T> {
  data: T | null;
  message: string;

  private constructor(data: T | null, message: string) {
    this.data = data;
    this.message = message;
  }

  static success<T>(data: T, message: string): ApiResponse<T> {
    return new ApiResponse(data, message);
  }

  static error(message: string): ApiResponse<null> {
    return new ApiResponse(null, message);
  }
}

/**
 * 에러 응답 공통 Swagger schema 상수.
 * @ApiXxxResponse({ schema: errorSchema('설명') }) 형태로 사용합니다.
 * 클래스 기반(type:) 방식은 reflect-metadata가 null 타입을 잘못 추론해
 * 순환 참조 경고를 발생시키므로 인라인 schema 방식을 사용합니다.
 */
export function errorSchema(example = 'Error message') {
  return {
    properties: {
      data: { type: 'object', nullable: true, example: null },
      message: { type: 'string', example },
    },
  };
}
