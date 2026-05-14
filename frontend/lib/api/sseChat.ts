/**
 * POST /sse — NestJS `MessageEvent` 기반 SSE (EventSource 미사용).
 * fetch + ReadableStream + TextDecoder 로 수신하며 `\n\n` / `\r\n\r\n` 경계로 프레임을 나눈다.
 */

export type SseChatRequestBody = {
  message: string;
  guestId?: string;
  userId?: string | number;
};

export type SseClientEvent =
  | { type: 'status'; step: string; message: string }
  | { type: 'chat'; text: string; message: string }
  | { type: 'done'; ok?: boolean; message: string }
  | { type: 'error'; code: string; message: string }
  | { type: 'notice'; message: string }
  | { type: 'ping'; at: number };

export function getApiBaseUrl(): string {
  const raw = process.env.NEXT_PUBLIC_API_BASE_URL?.trim();
  const base = raw && raw.length > 0 ? raw : 'http://localhost:8080';
  return base.replace(
    /\/$/,
    '',
  );
}

/** 버퍼에서 첫 번째 완전한 SSE 프레임을 꺼낸다. 없으면 `null`. */
function pullNextFrame(buffer: string): [string, string] | null {
  const idxNn = buffer.indexOf('\n\n');
  const idxRn = buffer.indexOf('\r\n\r\n');
  if (idxNn === -1 && idxRn === -1) {
    return null;
  }
  const useRn = idxRn !== -1 && (idxNn === -1 || idxRn < idxNn);
  if (useRn) {
    return [buffer.slice(0, idxRn), buffer.slice(idxRn + 4)];
  }
  return [buffer.slice(0, idxNn), buffer.slice(idxNn + 2)];
}

function parseSseFrameBlock(rawBlock: string): SseClientEvent | null {
  const lines = rawBlock.split(/\r?\n/).filter((l) => l.length > 0);
  let eventName: string | undefined;
  const dataParts: string[] = [];

  for (const line of lines) {
    if (line.startsWith(':')) {
      continue;
    }
    if (line.startsWith('event:')) {
      eventName = line.slice(6).trim();
      continue;
    }
    if (line.startsWith('data:')) {
      dataParts.push(line.slice(5).trimStart());
    }
  }

  const dataStr = dataParts.join('\n').trim();
  if (!dataStr) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(dataStr) as unknown;
  } catch {
    return null;
  }

  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    const o = parsed as Record<string, unknown>;
    if (o.ping === true && typeof o.at === 'number') {
      return { type: 'ping', at: o.at };
    }
  }

  const envelope =
    parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as { data?: unknown; message?: unknown })
      : null;
  if (!envelope) {
    return null;
  }

  const message = typeof envelope.message === 'string' ? envelope.message : '';
  const inner = envelope.data;

  const ev = eventName?.trim() || 'message';

  switch (ev) {
    case 'status': {
      const step =
        inner &&
        typeof inner === 'object' &&
        !Array.isArray(inner) &&
        typeof (inner as { step?: unknown }).step === 'string'
          ? (inner as { step: string }).step
          : '';
      return { type: 'status', step, message };
    }
    case 'chat': {
      let text = '';
      if (inner && typeof inner === 'object' && !Array.isArray(inner)) {
        const t = (inner as { text?: unknown }).text;
        if (typeof t === 'string') {
          text = t;
        }
      }
      return { type: 'chat', text, message: message || text };
    }
    case 'done': {
      let ok: boolean | undefined;
      if (inner && typeof inner === 'object' && !Array.isArray(inner)) {
        const v = (inner as { ok?: unknown }).ok;
        if (typeof v === 'boolean') {
          ok = v;
        }
      }
      return { type: 'done', ok, message };
    }
    case 'error': {
      let code = 'UNKNOWN';
      if (inner && typeof inner === 'object' && !Array.isArray(inner)) {
        const c = (inner as { code?: unknown }).code;
        if (typeof c === 'string') {
          code = c;
        }
      }
      return { type: 'error', code, message: message || code };
    }
    case 'notice':
      return { type: 'notice', message };
    default:
      return null;
  }
}

function processBufferChunk(
  buffer: string,
  onEvent: (e: SseClientEvent) => void,
): string {
  let rest = buffer;
  for (;;) {
    const pulled = pullNextFrame(rest);
    if (!pulled) {
      return rest;
    }
    const [frame, next] = pulled;
    rest = next;
    const ev = parseSseFrameBlock(frame);
    if (ev) {
      onEvent(ev);
    }
  }
}

export type PostSseChatOptions = {
  signal?: AbortSignal;
  onEvent: (event: SseClientEvent) => void;
};

/**
 * `POST {base}/sse` 로 스트림을 연다. `done` / `error` 이벤트 후에도 바이트가 남을 수 있으므로
 * 호출 측에서 종료 처리를 한다.
 */
export async function postSseChat(
  body: SseChatRequestBody,
  options: PostSseChatOptions,
): Promise<void> {
  const { signal, onEvent } = options;
  const url = `${getApiBaseUrl()}/sse`;

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
    },
    body: JSON.stringify(body),
    signal,
    credentials: 'include',
  });

  if (!res.ok) {
    let detail = res.statusText;
    try {
      const text = await res.text();
      if (text) {
        detail = text.slice(0, 500);
      }
    } catch {
      /* ignore */
    }
    throw new Error(`SSE 요청 실패 (${res.status}): ${detail}`);
  }

  if (!res.body) {
    throw new Error('응답 본문(stream)이 없습니다.');
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }
      if (value) {
        buffer += decoder.decode(value, { stream: true });
        buffer = processBufferChunk(buffer, onEvent);
      }
    }
    buffer += decoder.decode();
    buffer = processBufferChunk(buffer, onEvent);
    const tail = buffer.trim();
    if (tail.length > 0) {
      const ev = parseSseFrameBlock(tail);
      if (ev) {
        onEvent(ev);
      }
    }
  } finally {
    reader.releaseLock();
  }
}
