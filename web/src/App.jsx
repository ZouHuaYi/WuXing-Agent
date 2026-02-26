import React, { useState } from "react";
import ChatPanel from "./components/ChatPanel.jsx";
import ThoughtStream from "./components/ThoughtStream.jsx";
import StatusPanel from "./components/StatusPanel.jsx";
import WorkspaceExplorer from "./components/WorkspaceExplorer.jsx";
import ApprovalGate from "./components/ApprovalGate.jsx";
import TerminalMonitor from "./components/TerminalMonitor.jsx";
import { useSSE } from "./hooks/useSSE.js";
import { LayoutPanelLeft, BrainCircuit, FolderCode, ChevronRight, ChevronLeft, TerminalSquare } from "lucide-react";

// 五行能量指示条：基于最近10条思维流事件
function ElementBar({ thoughts }) {
  const count = { water: 0, fire: 0, earth: 0, metal: 0, wood: 0 };
  thoughts.slice(-20).forEach((t) => { if (count[t.element] !== undefined) count[t.element]++; });
  const total = Object.values(count).reduce((s, v) => s + v, 0) || 1;

  const elements = [
    { key: "water", label: "水", color: "#38bdf8" },
    { key: "fire",  label: "火", color: "#f97316" },
    { key: "earth", label: "土", color: "#eab308" },
    { key: "metal", label: "金", color: "#a8a29e" },
    { key: "wood",  label: "木", color: "#4ade80" },
  ];

  return (
    <div className="flex items-center gap-1 px-3 py-1.5 border-b border-gray-800 bg-gray-950">
      <span className="text-[10px] text-gray-600 mr-1">五行</span>
      {elements.map((el) => {
        const pct = Math.round((count[el.key] / total) * 100);
        return (
          <div key={el.key} className="flex items-center gap-1" title={`${el.label}: ${pct}%`}>
            <span className="text-[10px]" style={{ color: el.color }}>{el.label}</span>
            <div className="w-8 h-1.5 bg-gray-800 rounded-full overflow-hidden">
              <div
                className="h-full rounded-full transition-all duration-500"
                style={{ width: `${pct}%`, background: el.color }}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}

// 右侧面板选项卡
const RIGHT_TABS = [
  { id: "thought", label: "思维",    icon: BrainCircuit },
  { id: "status",  label: "状态",    icon: LayoutPanelLeft },
  { id: "workspace",label: "工作区", icon: FolderCode },
  { id: "terminal",label: "监控室", icon: TerminalSquare },
];

export default function App() {
  const { thoughts, connected, clear } = useSSE(80);
  const [rightTab, setRightTab] = useState("thought");
  const [sidebarOpen, setSidebarOpen] = useState(true);

  return (
    <div className="flex flex-col h-screen bg-gray-950 text-gray-100 overflow-hidden">
      <ApprovalGate thoughts={thoughts} />
      {/* ── 顶栏 ── */}
      <header className="shrink-0 flex items-center gap-3 px-4 py-2.5 border-b border-gray-800 bg-gray-950 z-10">
        <div className="flex items-center gap-2">
          <span className="text-xl">☯️</span>
          <div>
            <h1 className="text-sm font-bold text-white leading-none">WuXing-Agent</h1>
            <p className="text-[10px] text-gray-500 leading-none mt-0.5">五行智能体控制台</p>
          </div>
        </div>

        {/* 五行能量条 */}
        <div className="flex-1 flex items-center gap-1">
          {[
            { key: "water", label: "水", color: "#38bdf8" },
            { key: "fire",  label: "火", color: "#f97316" },
            { key: "earth", label: "土", color: "#eab308" },
            { key: "metal", label: "金", color: "#a8a29e" },
            { key: "wood",  label: "木", color: "#4ade80" },
          ].map((el) => {
            const cnt = thoughts.slice(-20).filter((t) => t.element === el.key).length;
            const pct = Math.min(cnt * 12, 100);
            return (
              <div key={el.key} className="flex items-center gap-1" title={`${el.label}`}>
                <span className="text-[10px] hidden sm:inline" style={{ color: el.color }}>{el.label}</span>
                <div className="w-12 h-1.5 bg-gray-800 rounded-full overflow-hidden">
                  <div className="h-full rounded-full transition-all duration-700"
                    style={{ width: `${pct}%`, background: el.color }} />
                </div>
              </div>
            );
          })}
        </div>

        <div className="flex items-center gap-2">
          <div className={`w-1.5 h-1.5 rounded-full pulse-dot ${connected ? "bg-green-400" : "bg-red-500"}`} />
          <span className="text-[10px] text-gray-500">{connected ? "已连接" : "重连中"}</span>
        </div>
      </header>

      {/* ── 主体 ── */}
      <div className="flex flex-1 min-h-0">
        {/* 对话区 */}
        <div className="flex-1 min-w-0">
          <ChatPanel thoughts={thoughts} />
        </div>

        {/* 分隔线 + 折叠按钮 */}
        <div className="relative flex items-center">
          <div className="w-px h-full bg-gray-800" />
          <button
            onClick={() => setSidebarOpen(!sidebarOpen)}
            className="absolute left-1/2 -translate-x-1/2 z-10
              w-4 h-10 bg-gray-800 hover:bg-gray-700 border border-gray-700
              rounded-full flex items-center justify-center transition-colors"
          >
            {sidebarOpen
              ? <ChevronRight size={10} className="text-gray-400" />
              : <ChevronLeft size={10} className="text-gray-400" />
            }
          </button>
        </div>

        {/* 右侧面板 */}
        {sidebarOpen && (
          <div className="w-80 shrink-0 flex flex-col border-l border-gray-800 bg-gray-950">
            {/* 标签选择 */}
            <div className="flex shrink-0 border-b border-gray-800">
              {RIGHT_TABS.map((t) => {
                const Icon = t.icon;
                return (
                  <button
                    key={t.id}
                    onClick={() => setRightTab(t.id)}
                    className={`flex-1 flex items-center justify-center gap-1 py-2 text-[11px] font-medium transition-colors
                      ${rightTab === t.id
                        ? "text-indigo-400 border-b-2 border-indigo-500 bg-indigo-950/30"
                        : "text-gray-500 hover:text-gray-300"
                      }`}
                  >
                    <Icon size={12} />
                    {t.label}
                  </button>
                );
              })}
            </div>

            {/* 面板内容 */}
            <div className="flex-1 min-h-0">
              {rightTab === "thought" && (
                <ThoughtStream thoughts={thoughts} connected={connected} onClear={clear} />
              )}
              {rightTab === "status" && <StatusPanel />}
              {rightTab === "workspace" && <WorkspaceExplorer />}
              {rightTab === "terminal" && <TerminalMonitor thoughts={thoughts} />}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
