import { BadRequestException } from '@nestjs/common';

/** 한국 표준시 고정 오프셋 (DST 없음) */
const KST_OFFSET_SUFFIX = '+09:00';

/**
 * 문자열 끝이 Z 또는 T 이후 ±오프셋을 포함하면 true (이 경우 ISO 그대로 `new Date`로 해석).
 */
export function pickupStringHasExplicitTimezone(raw: string): boolean {
  const s = raw.trim();
  if (!s) return false;
  if (/[zZ]$/.test(s)) return true;
  const t = s.indexOf('T');
  if (t === -1) return false;
  const afterT = s.slice(t + 1);
  return /[+-]\d{2}:\d{2}$/.test(afterT) || /[+-]\d{4}$/.test(afterT);
}

/**
 * 픽업 시각 문자열을 **절대 시각(Date)** 으로 변환합니다.
 *
 * - AI/클라이언트는 기본적으로 **KST 벽시각**을 보냅니다 (`2026-05-13T18:00:00` 처럼 타임존 생략).
 * - 타임존이 없으면 해당 시각을 **Asia/Seoul** 로 해석합니다 (`…+09:00` 부착).
 * - `Z` 또는 `±HH:MM` 이 있으면 ISO 8601 규칙 그대로 해석합니다.
 */
export function parsePickupInstantFromClientString(raw: string): Date {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new BadRequestException('픽업 시간이 비어 있습니다.');
  }

  let iso = trimmed;
  if (!pickupStringHasExplicitTimezone(trimmed)) {
    if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
      iso = `${trimmed}T00:00:00${KST_OFFSET_SUFFIX}`;
    } else {
      iso = `${trimmed}${KST_OFFSET_SUFFIX}`;
    }
  }

  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) {
    throw new BadRequestException(
      `유효하지 않은 픽업 시간 형식입니다. (KST 예: 2026-05-13T18:00:00 또는 ISO with Z/offset)`,
    );
  }
  return d;
}

/**
 * 픽업 시각이 [현재 순간 − graceMs] 보다 이전이면 true.
 * `pickup`은 이미 `parsePickupInstantFromClientString` 등으로 구한 절대 시각이어야 합니다.
 */
export function isPickupInstantBeforeGraceThreshold(pickup: Date, graceMs: number): boolean {
  return pickup.getTime() < Date.now() - graceMs;
}

/**
 * Redis에 저장할 `pickup_time` 문자열.
 *
 * - 클라이언트는 **KST 벽시각**을 보낸다고 가정한다.
 * - 이미 `Z` 또는 `±offset`이 있으면 **입력을 그대로** 둔다.
 * - 타임존이 없으면 **시·분·초 숫자는 바꾸지 않고** 끝에 `+09:00`만 붙인다 (`toISOString()`으로 UTC·Z로 바꾸지 않음).
 */
export function normalizePickupTimeForStorage(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return trimmed;
  if (pickupStringHasExplicitTimezone(trimmed)) {
    return trimmed;
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    return `${trimmed}T00:00:00${KST_OFFSET_SUFFIX}`;
  }
  return `${trimmed}${KST_OFFSET_SUFFIX}`;
}
