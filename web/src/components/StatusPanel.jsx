import React, { useEffect, useState } from "react";
import { fetchStatus, fetchSkills, fetchMemory, fetchGoals, sendCommand } from "../lib/api.js";
import { RefreshCw, Zap, Brain, Target, ShieldAlert } from "lucide-react";
import ReactMarkdown from "react-markdown";

function Tab({ active, onClick, children }) {
  return (
    <button
      onClick={onClick}
      className={`px-3 py-1.5 text-xs font-medium rounded-lg transition-colors ${
        active ? "bg-indigo-700 text-white" : "text-gray-400 hover:text-gray-200"
      }`}
    >
      {children}
    </button>
  );
}

function Badge({ color = "gray", children }) {
  const colors = {
    green:  "bg-green-900/40 text-green-300",
    red:    "bg-red-900/40 text-red-300",
    yellow: "bg-yellow-900/40 text-yellow-300",
    gray:   "bg-gray-800 text-gray-400",
    purple: "bg-purple-900/40 text-purple-300",
  };
  return (
    <span className={`px-2 py-0.5 rounded-full text-[10px] font-medium ${colors[color]}`}>
      {children}
    </span>
  );
}

export default function StatusPanel() {
  const [tab, setTab]       = useState("status");
  const [status, setStatus] = useState(null);
  const [skills, setSkills] = useState(null);
  const [memory, setMemory] = useState(null);
  const [goals, setGoals]   = useState(null);
  const [cmdResult, setCmdResult] = useState("");
  const [loading, setLoading]     = useState(false);

  async function refresh() {
    setLoading(true);
    try {
      if (tab === "status") setStatus(await fetchStatus());
      if (tab === "skills") setSkills(await fetchSkills());
      if (tab === "memory") setMemory(await fetchMemory());
      if (tab === "goals")  setGoals(await fetchGoals());
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { refresh(); }, [tab]);

  async function execCmd(cmd) {
    const { result, error } = await sendCommand(cmd);
    setCmdResult(result ?? error ?? "");
    if (cmd.startsWith(":reset")) {
      window.dispatchEvent(new Event("wuxing:reset"));
    }
    await refresh();
  }

  return (
    <div className="flex flex-col h-full">
      {/* 标签栏 */}
      <div className="flex items-center gap-1 px-3 py-2 border-b border-gray-800 shrink-0 flex-wrap">
        <Tab active={tab === "status"} onClick={() => setTab("status")}>
          <ShieldAlert size={11} className="inline mr-1" />状态
        </Tab>
        <Tab active={tab === "skills"} onClick={() => setTab("skills")}>
          <Zap size={11} className="inline mr-1" />技能
        </Tab>
        <Tab active={tab === "memory"} onClick={() => setTab("memory")}>
          <Brain size={11} className="inline mr-1" />记忆
        </Tab>
        <Tab active={tab === "goals"} onClick={() => setTab("goals")}>
          <Target size={11} className="inline mr-1" />目标
        </Tab>
        <button onClick={refresh} disabled={loading}
          className="ml-auto text-gray-500 hover:text-gray-300 transition-colors disabled:opacity-40">
          <RefreshCw size={12} className={loading ? "animate-spin" : ""} />
        </button>
      </div>

      {/* 内容区 */}
      <div className="flex-1 overflow-y-auto p-3 text-xs space-y-2">

        {/* ── 状态面板 ── */}
        {tab === "status" && (
          <>
            {status ? (
              <>
                <div className="bg-gray-900 rounded-lg p-3">
                  <p className="text-gray-400 text-[10px] mb-2 font-semibold uppercase tracking-wider">摘要</p>
                  <p className="text-gray-300 leading-relaxed whitespace-pre-wrap">{status.summary}</p>
                </div>

                {status.defects?.open?.length > 0 && (
                  <div className="bg-gray-900 rounded-lg p-3">
                    <p className="text-red-400 text-[10px] mb-2 font-semibold uppercase tracking-wider">
                      待修复缺陷 ({status.defects.open.length})
                    </p>
                    {status.defects.open.map((d, i) => (
                      <div key={i} className="mb-2 last:mb-0">
                        <p className="text-gray-300">{d.task?.slice(0, 60)}</p>
                        <p className="text-gray-500 text-[10px] mt-0.5">{d.error?.slice(0, 80)}</p>
                        <button
                          onClick={() => execCmd(`:status resolve ${d.task?.slice(0, 20)}`)}
                          className="mt-1 text-[10px] text-green-400 hover:text-green-300"
                        >
                          标记修复 ✓
                        </button>
                      </div>
                    ))}
                  </div>
                )}

                <div className="flex gap-2">
                  <button onClick={() => execCmd(":reload")}
                    className="flex-1 py-1.5 bg-indigo-800/40 hover:bg-indigo-700/40 text-indigo-300 rounded-lg text-[10px] transition-colors">
                    重载技能
                  </button>
                  <button onClick={() => execCmd(":status")}
                    className="flex-1 py-1.5 bg-gray-800 hover:bg-gray-700 text-gray-300 rounded-lg text-[10px] transition-colors">
                    刷新状态板
                  </button>
                </div>

                {cmdResult && (
                  <div className="bg-gray-900 rounded-lg p-2 text-gray-400 whitespace-pre-wrap text-[10px]">
                    {cmdResult}
                  </div>
                )}
              </>
            ) : (
              <p className="text-gray-500 text-center py-4">加载中...</p>
            )}
          </>
        )}

        {/* ── 技能面板 ── */}
        {tab === "skills" && (
          <>
            {skills ? (
              <div className="space-y-1.5">
                <p className="text-gray-500 text-[10px]">共 {skills.count} 个工具</p>
                {skills.skills?.map((s) => (
                  <div key={s.name} className="bg-gray-900 rounded-lg p-2.5 flex gap-2 items-start">
                    <span className="text-purple-400 shrink-0">🔧</span>
                    <div>
                      <p className="text-purple-300 font-mono text-[11px]">{s.name}</p>
                      <p className="text-gray-500 text-[10px] mt-0.5 leading-relaxed">{s.description}</p>
                    </div>
                  </div>
                ))}
              </div>
            ) : <p className="text-gray-500 text-center py-4">加载中...</p>}
          </>
        )}

        {/* ── 记忆面板 ── */}
        {tab === "memory" && (
          <>
            {memory ? (
              <div className="space-y-2">
                <button
                  onClick={() => {
                    if (window.confirm("确认重置测试数据？将清空记忆、会话、状态和 workspace。")) {
                      execCmd(":reset");
                    }
                  }}
                  className="w-full py-1.5 bg-red-900/40 hover:bg-red-800/40 text-red-300 rounded-lg text-[10px] transition-colors"
                >
                  重置测试数据
                </button>
                <div className="flex gap-2">
                  <div className="flex-1 bg-gray-900 rounded-lg p-2.5 text-center">
                    <p className="text-2xl font-bold text-green-400">{memory.total}</p>
                    <p className="text-gray-500 text-[10px]">因果律总数</p>
                  </div>
                  <div className="flex-1 bg-gray-900 rounded-lg p-2.5 text-center">
                    <p className="text-2xl font-bold text-indigo-400">
                      {memory.stats?.core ?? "—"}
                    </p>
                    <p className="text-gray-500 text-[10px]">核心记忆</p>
                  </div>
                </div>

                <p className="text-gray-500 text-[10px] pt-1 font-semibold uppercase tracking-wider">
                  最近因果律
                </p>
                {memory.recent?.map((d, i) => (
                  <div key={i} className="bg-gray-900 rounded-lg p-2.5">
                    <div className="flex items-center gap-1.5 mb-1">
                      <Badge color={d.memory_type === "core" ? "green" : d.memory_type === "short_term" ? "yellow" : "gray"}>
                        {d.memory_type}
                      </Badge>
                      <Badge color="purple">置信 {d.confidence}%</Badge>
                    </div>
                    <p className="text-gray-300 text-[11px] leading-relaxed">{d.rule}</p>
                    <p className="text-gray-600 text-[10px] mt-0.5 truncate">{d.task}</p>
                  </div>
                ))}
              </div>
            ) : <p className="text-gray-500 text-center py-4">加载中...</p>}
          </>
        )}

        {/* ── 目标面板 ── */}
        {tab === "goals" && (
          <>
            {goals ? (
              <div className="space-y-2">
                <button
                  onClick={() => {
                    if (window.confirm("确认清空所有目标？此操作仅影响目标数据。")) {
                      execCmd(":goal reset");
                    }
                  }}
                  className="w-full py-1.5 bg-red-900/30 hover:bg-red-800/40 text-red-300 rounded-lg text-[10px] transition-colors"
                >
                  重置目标
                </button>
                {goals.briefing && (
                  <div className="bg-gray-900 rounded-lg p-2.5 text-gray-400 text-[10px] leading-relaxed whitespace-pre-wrap">
                    {goals.briefing}
                  </div>
                )}
                {goals.goals?.map((g) => (
                  <div key={g.id} className="bg-gray-900 rounded-lg p-2.5">
                    <div className="flex items-center gap-2 mb-1">
                      <Badge color={g.status === "active" ? "green" : g.status === "paused" ? "yellow" : "gray"}>
                        {g.status}
                      </Badge>
                      <Badge color="purple">{g.progress ?? 0}%</Badge>
                    </div>
                    <p className="text-gray-200 font-medium">{g.title}</p>
                    {g.description && (
                      <p className="text-gray-500 text-[10px] mt-0.5">{g.description}</p>
                    )}
                    {g.milestones?.length > 0 && (
                      <div className="mt-2 space-y-0.5">
                        {g.milestones.slice(0, 3).map((m) => (
                          <div key={m.id} className="flex items-center gap-1.5 text-[10px]">
                            <span>{m.done ? "✅" : "⬜"}</span>
                            <span className={m.done ? "text-gray-600 line-through" : "text-gray-400"}>
                              {m.title}
                            </span>
                          </div>
                        ))}
                        {g.milestones.length > 3 && (
                          <p className="text-gray-600 text-[10px]">
                            +{g.milestones.length - 3} 个里程碑...
                          </p>
                        )}
                      </div>
                    )}
                  </div>
                ))}
                {(!goals.goals || goals.goals.length === 0) && (
                  <p className="text-gray-500 text-center py-4">
                    暂无目标。在对话框输入 ":vision 你的愿景" 创建。
                  </p>
                )}
                {cmdResult && (
                  <div className="bg-gray-900 rounded-lg p-2 text-gray-400 whitespace-pre-wrap text-[10px]">
                    {cmdResult}
                  </div>
                )}
              </div>
            ) : <p className="text-gray-500 text-center py-4">加载中...</p>}
          </>
        )}
      </div>
    </div>
  );
}
