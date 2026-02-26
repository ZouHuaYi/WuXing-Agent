import { useEffect, useRef, useState } from "react";
import { subscribeStream } from "../lib/api.js";

// 订阅 SSE 思维流，保留最近 N 条事件
export function useSSE(maxItems = 60) {
  const [thoughts, setThoughts] = useState([]);
  const [connected, setConnected]  = useState(false);
  const closeRef = useRef(null);

  useEffect(() => {
    let active = true;
    let retryTimer = null;

    function connect() {
      const close = subscribeStream((event) => {
        if (!active) return;
        setConnected(true);
        setThoughts((prev) => {
          const next = [...prev, { ...event, id: Date.now() + Math.random() }];
          return next.length > maxItems ? next.slice(-maxItems) : next;
        });
      });
      closeRef.current = close;
    }

    connect();

    return () => {
      active = false;
      closeRef.current?.();
      clearTimeout(retryTimer);
    };
  }, [maxItems]);

  const clear = () => setThoughts([]);

  return { thoughts, connected, clear };
}
