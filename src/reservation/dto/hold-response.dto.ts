export type HoldItemStatus = 'HELD' | 'OUT_OF_STOCK';

export class HoldItemResultDto {
  breadName: string;
  requestedQty: number;
  heldQty: number;
  status: HoldItemStatus;
}

/**
 * POST /v1/reservations/hold 응답.
 * HELD / OUT_OF_STOCK 는 DTO 상태이며 DB reservation.status 와 무관.
 */
export class HoldResponseDto {
  holdToken: string;
  items: HoldItemResultDto[];
}
