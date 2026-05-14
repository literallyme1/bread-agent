"use client";

import React, { useEffect, useRef } from "react";
import { Send } from "lucide-react";
import { Spinner } from "@/components/ui/spinner";
import { useSseChat } from "@/hooks/useSseChat";

export default function Chat() {
  const {
    messages,
    isLoading,
    statusText,
    streamError,
    sendMessage,
    clearStreamError,
  } = useSseChat();
  const [input, setInput] = React.useState("");
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, statusText, isLoading]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim() || isLoading) return;
    const text = input;
    setInput("");
    void sendMessage(text);
  };

  return (
    <div className="flex flex-col h-screen bg-[#FFF9F0]">
      <header className="p-4 bg-[#8B4513] text-white shadow-md flex justify-center items-center gap-2">
        <span className="text-2xl">🍞</span>
        <h1 className="text-xl font-bold font-sans">Bread Agent</h1>
      </header>

      {streamError ? (
        <div
          className="mx-4 mt-3 flex items-start justify-between gap-2 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-900"
          role="alert"
        >
          <span className="pt-0.5">{streamError}</span>
          <button
            type="button"
            onClick={clearStreamError}
            className="shrink-0 rounded-lg px-2 py-1 text-xs font-medium text-red-800 hover:bg-red-100"
          >
            닫기
          </button>
        </div>
      ) : null}

      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto p-4 space-y-4 shadow-inner"
      >
        {messages.map((m) => (
          <div
            key={m.id}
            className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}
          >
            <div
              className={`flex gap-2 max-w-[85%] ${m.role === "user" ? "flex-row-reverse" : "flex-row"}`}
            >
              <div className="text-2xl mt-1 shrink-0">
                {m.role === "user" ? "👤" : "🥖"}
              </div>
              <div
                className={`p-3 rounded-2xl shadow-sm ${
                  m.role === "user"
                    ? "bg-[#D2691E] text-white rounded-tr-none"
                    : "bg-white text-[#5D4037] border-2 border-[#F5DEB3] rounded-tl-none"
                }`}
              >
                {m.content.length > 0 ? (
                  m.content
                ) : m.role === "assistant" && isLoading ? (
                  <span className="inline-flex items-center gap-2 text-gray-500">
                    <Spinner className="size-4" />
                    {statusText ?? "응답을 기다리는 중…"}
                  </span>
                ) : null}
              </div>
            </div>
          </div>
        ))}
      </div>

      <div className="p-4 bg-white border-t border-[#F5DEB3]">
        {statusText && !streamError ? (
          <p className="mb-2 text-center text-xs text-[#8B4513]">{statusText}</p>
        ) : null}
        <form onSubmit={handleSubmit} className="flex gap-2 max-w-4xl mx-auto">
          <input
            className="flex-1 p-3 border-2 border-[#F5DEB3] rounded-xl focus:outline-none focus:ring-2 focus:ring-[#8B4513] text-[#5D4037] placeholder:text-gray-400 disabled:opacity-60"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="빵에 대해 무엇이든 물어보세요..."
            disabled={isLoading}
          />
          <button
            type="submit"
            disabled={isLoading}
            className="p-3 bg-[#8B4513] text-white rounded-xl hover:bg-[#5D4037] transition-colors shadow-md flex items-center justify-center disabled:opacity-60 min-w-[52px]"
          >
            {isLoading ? <Spinner className="size-5" /> : <Send size={20} />}
          </button>
        </form>
        <p className="text-center text-[10px] text-gray-400 mt-2 font-mono">
          BAKED BY BREAD-AGENT v1.0
        </p>
      </div>
    </div>
  );
}
