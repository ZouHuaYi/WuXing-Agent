import React, { useEffect, useMemo, useState } from "react";
import {
  startExternalAgent,
  fetchExternalTasks,
  sendExternalInput,
  stopExternalTask,
} from "../lib/api.js";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";

export default function TerminalMonitor({ thoughts = [] }) {
  const [agentName, setAgentName] = useState("codex");
  const [taskPrompt, setTaskPrompt] = useState("");
  const [autoApprove, setAutoApprove] = useState(true);
  const [timeoutMs, setTimeoutMs] = useState(600000);
  const [tasks, setTasks] = useState([]);
  const [activeId, setActiveId] = useState("");
  const [manualInput, setManualInput] = useState("y\n");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [wsConnected, setWsConnected] = useState(false);
  const [promptEvent, setPromptEvent] = useState(null);
  const [buffers, setBuffers] = useState({});

  const termRef = React.useRef(null);
  const termHostRef = React.useRef(null);
  const fitRef = React.useRef(null);
  const wsRef = React.useRef(null);
  const activeIdRef = React.useRef(activeId);
  activeIdRef.current = activeId;

  const active = useMemo(
    () => tasks.find((t) => t.id === activeId) || tasks[0] || null,
    [tasks, activeId]
  );

  async function loadTasks() {
    const data = await fetchExternalTasks();
    const list = data.tasks ?? [];
    setTasks(list);
    if (!activeId && list.length > 0) setActiveId(list[0].id);
  }

  useEffect(() => {
    loadTasks().catch(() => {});
    const timer = setInterval(() => loadTasks().catch(() => {}), 3000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    const last = thoughts[thoughts.length - 1];
    if (!last) return;
    if (String(last.type || "").startsWith("terminal.")) {
      loadTasks().catch(() => {});
    }
  }, [thoughts]);

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
    wsRef.current = ws;
    ws.onopen = () => setWsConnected(true);
    ws.onclose = () => setWsConnected(false);
    ws.onerror = () => setWsConnected(false);
    ws.onmessage = (ev) => {
      try {
        const event = JSON.parse(ev.data);
        const t = event?.data?.taskId;
        if (!t) return;
        if (event.type === "terminal.stream") {
          const chunk = event?.data?.chunk ?? "";
          setBuffers((prev) => ({ ...prev, [t]: (prev[t] || "") + chunk }));
          if (activeIdRef.current === t && termRef.current) {
            termRef.current.write(chunk);
          }
        }
        if (event.type === "terminal.prompt") {
          setPromptEvent(event);
        }
      } catch {
        // ignore
      }
    };
    return () => ws.close();
  }, []);

  useEffect(() => {
    if (!termRef.current) return;
    termRef.current.clear();
    const fromBuf = buffers[activeId] || "";
    if (fromBuf) {
      termRef.current.write(fromBuf);
      return;
    }
    const fallback = (active?.logsTail ?? []).join("");
    if (fallback) termRef.current.write(fallback);
  }, [activeId, active?.id]);

  async function startTask() {
    setLoading(true);
    setError("");
    try {
      const data = await startExternalAgent({ agentName, taskPrompt, autoApprove, timeoutMs: Number(timeoutMs) || 600000 });
      if (data.error) throw new Error(data.error);
      const id = data.task?.id;
      await loadTasks();
      if (id) setActiveId(id);
      setTaskPrompt("");
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  async function sendInputNow() {
    if (!active?.id) return;
    await sendExternalInput(active.id, manualInput);
    setManualInput("y\n");
  }

  async function approveY() {
    if (!active?.id) return;
    await sendExternalInput(active.id, "y\n");
    setPromptEvent(null);
  }

  async function rejectN() {
    if (!active?.id) return;
    await sendExternalInput(active.id, "n\n");
    setPromptEvent(null);
  }

  async function stopNow() {
    if (!active?.id) return;
    await stopExternalTask(active.id);
    await loadTasks();
  }

  return (
    <div className="flex flex-col h-full text-xs">
      <div className="shrink-0 p-3 border-b border-gray-800 space-y-2">
        <div className="flex items-center gap-2 text-[10px] text-gray-500">
          <span className={`w-2 h-2 rounded-full ${wsConnected ? "bg-green-500" : "bg-red-500"}`} />
          <span>WS {wsConnected ? "已连接" : "未连接"}</span>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <input
            value={agentName}
            onChange={(e) => setAgentName(e.target.value)}
            placeholder="代理名: codex"
            className="px-2 py-1.5 rounded bg-gray-900 border border-gray-800 text-gray-200 outline-none"
          />
          <input
            type="number"
            value={timeoutMs}
            onChange={(e) => setTimeoutMs(e.target.value)}
            placeholder="timeoutMs"
            className="px-2 py-1.5 rounded bg-gray-900 border border-gray-800 text-gray-200 outline-none"
          />
        </div>
        <textarea
          value={taskPrompt}
          onChange={(e) => setTaskPrompt(e.target.value)}
          rows={3}
          placeholder="输入交给外部专家的任务..."
          className="w-full px-2 py-1.5 rounded bg-gray-900 border border-gray-800 text-gray-200 outline-none resize-y"
        />
        <div className="flex items-center gap-2">
          <label className="flex items-center gap-1 text-gray-400">
            <input
              type="checkbox"
              checked={autoApprove}
              onChange={(e) => setAutoApprove(e.target.checked)}
            />
            Auto-Approve
          </label>
          <button
            disabled={loading || !taskPrompt.trim()}
            onClick={startTask}
            className="ml-auto px-3 py-1.5 rounded bg-indigo-700 hover:bg-indigo-600 text-white disabled:opacity-50"
          >
            启动
          </button>
        </div>
        {error && <p className="text-red-400">{error}</p>}
      </div>

      <div className="flex-1 min-h-0 grid grid-cols-3">
        <div className="border-r border-gray-800 overflow-y-auto">
          {tasks.length === 0 && <p className="p-3 text-gray-500">暂无任务</p>}
          {tasks.map((t) => (
            <button
              key={t.id}
              onClick={() => setActiveId(t.id)}
              className={`w-full text-left p-2 border-b border-gray-900 ${active?.id === t.id ? "bg-gray-900" : "hover:bg-gray-900/60"}`}
            >
              <p className="text-gray-200 truncate">{t.agentName}</p>
              <p className="text-gray-500 truncate">{t.status} · {t.progress ?? 0}%</p>
            </button>
          ))}
        </div>

        <div className="col-span-2 flex flex-col min-h-0">
          <div className="shrink-0 p-2 border-b border-gray-800 flex items-center gap-2">
            <div className="flex-1 h-1.5 rounded bg-gray-800 overflow-hidden">
              <div
                className="h-full bg-green-500 transition-all"
                style={{ width: `${Math.max(0, Math.min(100, active?.progress || 0))}%` }}
              />
            </div>
            <span className="text-gray-400">{active?.progress ?? 0}%</span>
            <button onClick={stopNow} className="px-2 py-1 rounded bg-red-900/40 hover:bg-red-800/40 text-red-300">
              停止
            </button>
          </div>

          {promptEvent?.data?.taskId === active?.id && (
            <div className="shrink-0 p-2 border-b border-yellow-900/50 bg-yellow-900/20 text-yellow-300 flex items-center gap-2">
              <span className="text-[10px]">检测到终端确认提示</span>
              <button onClick={approveY} className="px-2 py-1 rounded bg-green-900/40 hover:bg-green-800/40 text-green-300">确认 Y</button>
              <button onClick={rejectN} className="px-2 py-1 rounded bg-red-900/40 hover:bg-red-800/40 text-red-300">拒绝 N</button>
            </div>
          )}

          <div className="flex-1 min-h-0 bg-black p-1 overflow-hidden">
            <div ref={termHostRef} className="w-full h-full" />
          </div>

          <div className="shrink-0 p-2 border-t border-gray-800 flex gap-2">
            <input
              value={manualInput}
              onChange={(e) => setManualInput(e.target.value)}
              className="flex-1 px-2 py-1 rounded bg-gray-900 border border-gray-800 text-gray-200 outline-none"
              placeholder="手动输入（例如 y\\n）"
            />
            <button onClick={sendInputNow} className="px-3 py-1 rounded bg-gray-800 hover:bg-gray-700 text-gray-200">
              发送
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
