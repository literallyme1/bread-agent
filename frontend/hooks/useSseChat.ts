"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { postSseChat, type SseClientEvent } from "@/lib/api/sseChat";

export type ChatMessage = {
  id: number;
  role: "user" | "assistant";
  content: string;
};

const INITIAL_MESSAGES: ChatMessage[] = [
  {
    id: 1,
    role: "assistant",
    content:
      "안녕하세요! 빵 예약 서비스 Bread Agent입니다.어느 지하철역 근처에서 어떤 빵을 찾으시나요?",
  },
];

export function useSseChat() {
  const [messages, setMessages] = useState<ChatMessage[]>(INITIAL_MESSAGES);
  const [isLoading, setIsLoading] = useState(false);
  const [statusText, setStatusText] = useState<string | null>(null);
  const [streamError, setStreamError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const streamingAssistantIdRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  const handleSseEvent = useCallback((assistantId: number, ev: SseClientEvent) => {
    switch (ev.type) {
      case "status":
        setStatusText(ev.message);
        return;
      case "chat":
        if (ev.text) {
          setMessages((prev) =>
            prev.map((m) =>
              m.id === assistantId ? { ...m, content: m.content + ev.text } : m,
            ),
          );
        }
        return;
      case "notice":
        setStatusText(ev.message);
        return;
      case "ping":
        return;
      case "error":
        setStreamError(ev.message);
        setMessages((prev) =>
          prev.map((m) => {
            if (m.id !== assistantId) {
              return m;
            }
            if (m.content.trim().length > 0) {
              return m;
            }
            return { ...m, content: ev.message };
          }),
        );
        return;
      case "done":
        setStatusText(null);
        return;
      default:
        return;
    }
  }, []);

  const sendMessage = useCallback(async (text: string) => {
    const trimmed = text.trim();
    if (!trimmed) {
      return;
    }

    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;

    const userId = Date.now();
    const assistantId = userId + 1;
    streamingAssistantIdRef.current = assistantId;

    setMessages((prev) => [
      ...prev,
      { id: userId, role: "user", content: trimmed },
      { id: assistantId, role: "assistant", content: "" },
    ]);
    setStreamError(null);
    setStatusText(null);
    setIsLoading(true);

    try {
      await postSseChat(
        { message: trimmed, userId: 1 },
        {
          signal: ac.signal,
          onEvent: (ev) => {
            handleSseEvent(assistantId, ev);
            if (ev.type === "error" || ev.type === "done") {
              if (streamingAssistantIdRef.current === assistantId) {
                streamingAssistantIdRef.current = null;
                setIsLoading(false);
                setStatusText(null);
              }
            }
          },
        },
      );
    } catch (e) {
      if (e instanceof Error && e.name === "AbortError") {
        if (streamingAssistantIdRef.current === assistantId) {
          streamingAssistantIdRef.current = null;
          setIsLoading(false);
          setStatusText(null);
        }
        return;
      }
      if (streamingAssistantIdRef.current !== assistantId) {
        return;
      }
      const msg = e instanceof Error ? e.message : "알 수 없는 오류가 발생했습니다.";
      setStreamError(msg);
      setMessages((prev) =>
        prev.map((m) => {
          if (m.id !== assistantId) {
            return m;
          }
          if (m.content.trim().length > 0) {
            return m;
          }
          return { ...m, content: msg };
        }),
      );
    } finally {
      if (streamingAssistantIdRef.current === assistantId) {
        streamingAssistantIdRef.current = null;
        setIsLoading(false);
        setStatusText(null);
      }
    }
  }, [handleSseEvent]);

  const clearStreamError = useCallback(() => {
    setStreamError(null);
  }, []);

  return {
    messages,
    isLoading,
    statusText,
    streamError,
    sendMessage,
    clearStreamError,
  };
}
