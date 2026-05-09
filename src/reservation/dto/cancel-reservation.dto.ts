import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

const CancelReservationSchema = z.object({
  userId: z.number().int().describe('취소 요청 사용자 ID (권한 검증)'),
});

export class CancelReservationDto extends createZodDto(CancelReservationSchema) {}
