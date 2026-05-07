/**
 * 모든 API 응답에 공통으로 사용되는 래퍼 DTO
 * { data, message } 형태로 통일
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
