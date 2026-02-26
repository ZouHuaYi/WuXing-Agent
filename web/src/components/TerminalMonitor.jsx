import React, { useEffect, useMemo, useState } from "react";
import { fetchExternalTasks } from "../lib/api.js";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";

export default function TerminalMonitor() {
  const [tasks, setTasks] = useState([]);
  const [activeId, setActiveId] = useState("");
  const [wsConnected, setWsConnected] = useState(false);
  const [buffers, setBuffers] = useState({});

  const termRef = React.useRef(null);
  const termHostRef = React.useRef(null);
  const fitRef = React.useRef(null);
  const activeIdRef = React.useRef(activeId);
  activeIdRef.current = activeId;

  const active = useMemo(() => {
    const sorted = [...tasks].sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
    return sorted.find((t) => t.status === "running" || t.status === "waiting_input")
      || sorted[0]
      || null;
  }, [tasks]);

  async function loadTasks() {
    const data = await fetchExternalTasks();
    const list = data.tasks ?? [];
    setTasks(list);
  }

  useEffect(() => {
    loadTasks().catch(() => {});
    const timer = setInterval(() => loadTasks().catch(() => {}), 3000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!termHostRef.current || termRef.current) return;
    const term = new Terminal({
      fontFamily: "Consolas, 'Courier New', monospace",
      fontSize: 12,
      cursorBlink: true,
      convertEol: true,
      theme: { background: "#000000", foreground: "#7CFC8A" },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(termHostRef.current);
    fit.fit();
    termRef.current = term;
    fitRef.current = fit;
    const onResize = () => fit.fit();
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, []);

  useEffect(() => {
    const proto = window.location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${proto}://${window.location.host}/ws`);
    ws.onopen = () => setWsConnected(true);
    ws.onclose = () => setWsConnected(false);
    ws.onerror = () => setWsConnected(false);
    ws.onmessage = (ev) => {
      try {
        const event = JSON.parse(ev.data);
        if (event.type !== "terminal.stream") return;
        const taskId = event?.data?.taskId;
        const chunk = event?.data?.chunk ?? "";
        if (!taskId) return;
        setBuffers((prev) => ({ ...prev, [taskId]: (prev[taskId] || "") + chunk }));
        if (activeIdRef.current === taskId && termRef.current) {
          termRef.current.write(chunk);
          termRef.current.scrollToBottom();
        }
      } catch {
        // ignore invalid ws frame
      }
    };
    return () => ws.close();
  }, []);

  useEffect(() => {
    const id = active?.id || "";
    if (id) setActiveId(id);
  }, [active?.id]);

  useEffect(() => {
    if (!termRef.current) return;
    termRef.current.clear();
    const text = buffers[activeId] || "";
    if (text) {
      termRef.current.write(text);
      termRef.current.scrollToBottom();
    }
  }, [activeId, buffers]);

  return (
    <div className="flex flex-col h-full text-xs">
      <div className="shrink-0 px-3 py-2 border-b border-gray-800 bg-gray-950 flex items-center gap-2">
        <span className={`w-2 h-2 rounded-full ${wsConnected ? "bg-green-500" : "bg-red-500"}`} />
        <span className="text-gray-500">执行日志</span>
      </div>
      <div className="flex-1 min-h-0 bg-black p-1 overflow-hidden">
        <div ref={termHostRef} className="w-full h-full" />
      </div>
    </div>
  );
}
