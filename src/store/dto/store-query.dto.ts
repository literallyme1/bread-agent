import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { Preference } from '../../common/enums/preference.enum';
import { Station } from '../../common/enums/station.enum';

//규칙 스키마 
const StoreQuerySchema = z.object({
  station: z
    .enum(Object.values(Station) as [string, ...string[]]).optional()
    .describe('지하철역 이름 (필수)'),

  breadName: z
    .string()
    .optional()
    .describe('빵 이름 (pg_trgm 유사 검색 적용 — 오타 보완 가능)'),

  preference: z
    .preprocess(
      (val) => {
        if (val === undefined || val === null) return undefined;
        return Array.isArray(val) ? val : [val];
      },
      z.array(
        z.enum(Object.values(Preference) as [string, ...string[]])
      ).optional(),
    )
    .describe(
      '태그(preference) 필터 — exact match, 여러 개 전달 시 OR 조건 적용\n' +
        '(e.g. ?preference=짭짤&preference=바삭)',
    ),

  storeName: z
    .string()
    .optional()
    .describe('매장 이름 (pg_trgm 유사 검색 적용 — 오타 보완 가능)'),
});
//dto 로 변환 
export class StoreQueryDto extends createZodDto(StoreQuerySchema) {}
