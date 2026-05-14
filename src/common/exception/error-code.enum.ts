import { HttpStatus } from '@nestjs/common';

export enum ErrorCode {
  STORE_NOT_FOUND = 'STORE_NOT_FOUND',
  INVENTORY_NOT_FOUND = 'INVENTORY_NOT_FOUND',
  OUT_OF_STOCK = 'OUT_OF_STOCK',
  RESERVATION_NOT_FOUND = 'RESERVATION_NOT_FOUND',
  ALREADY_CANCELLED = 'ALREADY_CANCELLED',
  USER_NOT_FOUND = 'USER_NOT_FOUND',
  INVALID_QUERY = 'INVALID_QUERY',
  FORBIDDEN = 'FORBIDDEN',
  INVALID_PICKUP_TIME = 'INVALID_PICKUP_TIME',
  OUTSIDE_BUSINESS_HOURS = 'OUTSIDE_BUSINESS_HOURS',
  HOLD_NOT_FOUND = 'HOLD_NOT_FOUND',
  HOLD_EXPIRED = 'HOLD_EXPIRED',
  HOLD_USER_MISMATCH = 'HOLD_USER_MISMATCH',
  STORE_CLOSED = 'STORE_CLOSED',
}

export const ErrorCodeMeta: Record<ErrorCode, { status: HttpStatus; message: string }> = {
  [ErrorCode.STORE_NOT_FOUND]: {
    status: HttpStatus.NOT_FOUND,
    message: 'Store not found',
  },
  [ErrorCode.INVENTORY_NOT_FOUND]: {
    status: HttpStatus.NOT_FOUND,
    message: 'Inventory not found',
  },
  [ErrorCode.OUT_OF_STOCK]: {
    status: HttpStatus.CONFLICT,
    message: 'Out of stock',
  },
  [ErrorCode.RESERVATION_NOT_FOUND]: {
    status: HttpStatus.NOT_FOUND,
    message: 'Reservation not found',
  },
  [ErrorCode.ALREADY_CANCELLED]: {
    status: HttpStatus.BAD_REQUEST,
    message: 'Reservation already cancelled',
  },
  [ErrorCode.USER_NOT_FOUND]: {
    status: HttpStatus.NOT_FOUND,
    message: 'User not found',
  },
  [ErrorCode.INVALID_QUERY]: {
    status: HttpStatus.BAD_REQUEST,
    message: 'Invalid query parameter',
  },
  [ErrorCode.FORBIDDEN]: {
    status: HttpStatus.FORBIDDEN,
    message: 'Access denied',
  },
  [ErrorCode.INVALID_PICKUP_TIME]: {
    status: HttpStatus.BAD_REQUEST,
    message: 'Pickup time must be a valid future datetime',
  },
  [ErrorCode.OUTSIDE_BUSINESS_HOURS]: {
    status: HttpStatus.BAD_REQUEST,
    message: 'Pickup time must be within business hours (09:00–21:00)',
  },
  [ErrorCode.HOLD_NOT_FOUND]: {
    status: HttpStatus.NOT_FOUND,
    message: 'Hold not found or already expired',
  },
  [ErrorCode.HOLD_EXPIRED]: {
    status: HttpStatus.BAD_REQUEST,
    message: 'Hold token has expired',
  },
  [ErrorCode.HOLD_USER_MISMATCH]: {
    status: HttpStatus.FORBIDDEN,
    message: 'Hold token does not belong to this user',
  },
  [ErrorCode.STORE_CLOSED]: {
    status: HttpStatus.BAD_REQUEST,
    message: 'Store is closed at requested pickup time',
  },
};
