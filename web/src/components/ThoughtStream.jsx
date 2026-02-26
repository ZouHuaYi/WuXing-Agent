import React, { useEffect, useRef } from "react";
import { getElement } from "../lib/elements.js";

function ThoughtItem({ event }) {
  const el = getElement(event.element);
  return (
    <div
      className="thought-item flex gap-2 py-1.5 px-2 rounded-lg text-xs"
      style={{ background: el.bg, borderLeft: `2px solid ${el.border}` }}
    >
      <span className="shrink-0 mt-0.5">{el.icon}</span>
      <div className="min-w-0">
        <span className="font-semibold" style={{ color: el.color }}>{el.label}</span>
        <p className="text-gray-300 mt-0.5 break-words leading-relaxed">
          {event.message}
        </p>
        {event.data?.tools && (
          <div className="mt-1 flex flex-wrap gap-1">
            {event.data.tools.map((t, i) => (
              <span key={i} className="px-1.5 py-0.5 bg-purple-900/40 text-purple-300 rounded text-[10px]">
                {t.name}
              </span>
            ))}
          </div>
        )}
        {event.data?.rule && (
          <p className="mt-1 text-[10px] text-green-400 italic">
            ↳ {event.data.rule}
          </p>
        )}
      </div>
    </div>
  );
}

export default function ThoughtStream({ thoughts, connected, onClear }) {
  const bottomRef = useRef(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [thoughts.length]);

  return (
    <div className="flex flex-col h-full">
      {/* 标题 */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-gray-800 shrink-0">
        <div className="flex items-center gap-2">
          <div
            className={`w-2 h-2 rounded-full pulse-dot ${connected ? "bg-green-400" : "bg-red-500"}`}
          />
          <span className="text-xs font-semibold text-gray-300">五行思维流</span>
        </div>
        <button
          onClick={onClear}
          className="text-[10px] text-gray-500 hover:text-gray-300 transition-colors"
        >
          清空
        </button>
      </div>

      {/* 事件列表 */}
      <div className="flex-1 overflow-y-auto px-2 py-2 space-y-1.5">
        {thoughts.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-gray-600 text-xs gap-2">
            <span className="text-2xl">☯️</span>
            <span>等待五行运转...</span>
          </div>
        ) : (
          thoughts.map((t) => <ThoughtItem key={t.id} event={t} />)
        )}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}
