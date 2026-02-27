import React, { useEffect, useState } from "react";
import {
  fetchStatus, fetchSkills, fetchMemory, fetchGoals, sendCommand,
  fetchApprovalPolicy, updateApprovalPolicy, fetchSelfProfile,
} from "../lib/api.js";
import { RefreshCw, Zap, Brain, Target, ShieldAlert, Scale, ScanEye } from "lucide-react";
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
  const [policy, setPolicy] = useState(null);
  const [policyDraft, setPolicyDraft] = useState(null);
  const [selfProfile, setSelfProfile] = useState(null);
  const [cmdResult, setCmdResult] = useState("");
  const [loading, setLoading]     = useState(false);
  const [savingPolicy, setSavingPolicy] = useState(false);

  async function refresh() {
    setLoading(true);
    try {
      if (tab === "status") setStatus(await fetchStatus());
      if (tab === "skills") setSkills(await fetchSkills());
      if (tab === "memory") setMemory(await fetchMemory());
      if (tab === "goals")  setGoals(await fetchGoals());
      if (tab === "self") setSelfProfile(await fetchSelfProfile());
      if (tab === "policy") {
        const p = await fetchApprovalPolicy();
        setPolicy(p);
        setPolicyDraft(JSON.parse(JSON.stringify(p)));
      }
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

  function patchRisk(risk, key, value) {
    setPolicyDraft((prev) => {
      if (!prev?.riskRules?.[risk]) return prev;
      return {
        ...prev,
        riskRules: {
          ...prev.riskRules,
          [risk]: { ...prev.riskRules[risk], [key]: value },
        },
      };
    });
  }

  async function savePolicy() {
    if (!policyDraft?.riskRules) return;
    setSavingPolicy(true);
    try {
      const normalized = { riskRules: {} };
      for (const risk of ["low", "medium", "high", "critical"]) {
        const rule = policyDraft.riskRules[risk] || {};
        normalized.riskRules[risk] = {
          autoApprove: !!rule.autoApprove,
          allowModify: !!rule.allowModify,
          timeoutMs: Math.max(5000, Number(rule.timeoutMs) || 60000),
        };
      }
      const r = await updateApprovalPolicy(normalized, true);
      if (!r.ok) throw new Error(r.error || "保存失败");
      setPolicy(r.policy);
      setPolicyDraft(JSON.parse(JSON.stringify(r.policy)));
      setCmdResult("审批策略已保存并生效。");
    } catch (e) {
      setCmdResult(`保存失败：${e.message}`);
    } finally {
      setSavingPolicy(false);
    }
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
        <Tab active={tab === "policy"} onClick={() => setTab("policy")}>
          <Scale size={11} className="inline mr-1" />策略
        </Tab>
        <Tab active={tab === "self"} onClick={() => setTab("self")}>
          <ScanEye size={11} className="inline mr-1" />自知
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

        {/* ── 策略面板 ── */}
        {tab === "policy" && (
          <>
            {policyDraft ? (
              <div className="space-y-2">
                <div className="bg-gray-900 rounded-lg p-2.5 text-[10px] text-gray-400">
                  审批策略热更新。保存后立即影响新审批请求，并落盘到 config/agents.json。
                </div>
                {["low", "medium", "high", "critical"].map((risk) => {
                  const rule = policyDraft.riskRules?.[risk] || {};
                  return (
                    <div key={risk} className="bg-gray-900 rounded-lg p-2.5 space-y-2">
                      <div className="flex items-center justify-between">
                        <span className="text-[11px] text-gray-200 font-semibold uppercase">{risk}</span>
                        <span className="text-[10px] text-gray-500">风险级别</span>
                      </div>
                      <div className="flex items-center justify-between text-[10px]">
                        <span className="text-gray-400">自动批准</span>
                        <input
                          type="checkbox"
                          checked={!!rule.autoApprove}
                          onChange={(e) => patchRisk(risk, "autoApprove", e.target.checked)}
                        />
                      </div>
                      <div className="flex items-center justify-between text-[10px]">
                        <span className="text-gray-400">允许修改指令</span>
                        <input
                          type="checkbox"
                          checked={!!rule.allowModify}
                          onChange={(e) => patchRisk(risk, "allowModify", e.target.checked)}
                        />
                      </div>
                      <div className="flex items-center justify-between text-[10px] gap-2">
                        <span className="text-gray-400">审批超时 (ms)</span>
                        <input
                          type="number"
                          min="5000"
                          step="1000"
                          value={Number(rule.timeoutMs) || 0}
                          onChange={(e) => patchRisk(risk, "timeoutMs", e.target.value)}
                          className="w-28 px-2 py-1 rounded bg-gray-800 border border-gray-700 text-gray-200"
                        />
                      </div>
                    </div>
                  );
                })}
                <div className="flex gap-2">
                  <button
                    onClick={() => setPolicyDraft(JSON.parse(JSON.stringify(policy)))}
                    className="flex-1 py-1.5 bg-gray-800 hover:bg-gray-700 text-gray-300 rounded-lg text-[10px] transition-colors"
                  >
                    还原
                  </button>
                  <button
                    disabled={savingPolicy}
                    onClick={savePolicy}
                    className="flex-1 py-1.5 bg-indigo-800/40 hover:bg-indigo-700/40 text-indigo-300 rounded-lg text-[10px] transition-colors disabled:opacity-50"
                  >
                    {savingPolicy ? "保存中..." : "保存并生效"}
                  </button>
                </div>
                {cmdResult && (
                  <div className="bg-gray-900 rounded-lg p-2 text-gray-400 whitespace-pre-wrap text-[10px]">
                    {cmdResult}
                  </div>
                )}
              </div>
            ) : <p className="text-gray-500 text-center py-4">加载中...</p>}
          </>
        )}

        {/* ── 自知面板 ── */}
        {tab === "self" && (
          <>
            {selfProfile ? (
              <div className="space-y-2">
                <div className="bg-gray-900 rounded-lg p-2.5">
                  <p className="text-gray-500 text-[10px] mb-2 font-semibold uppercase tracking-wider">能力画像</p>
                  <div className="grid grid-cols-2 gap-2 text-[10px]">
                    <div className="bg-gray-800 rounded p-2 text-gray-300">
                      本地工具：{(selfProfile.capabilities?.builtinTools?.length ?? 0) + (selfProfile.capabilities?.dynamicTools?.length ?? 0)}
                    </div>
                    <div className="bg-gray-800 rounded p-2 text-gray-300">
                      MCP 工具：{selfProfile.capabilities?.mcpTools?.length ?? 0}
                    </div>
                    <div className="bg-gray-800 rounded p-2 text-gray-300 col-span-2">
                      MCP 服务：{(selfProfile.capabilities?.mcpServersConfigured ?? []).join("、") || "无"}
                    </div>
                  </div>
                </div>

                <div className="bg-gray-900 rounded-lg p-2.5">
                  <p className="text-gray-500 text-[10px] mb-2 font-semibold uppercase tracking-wider">工作流</p>
                  <div className="space-y-1">
                    {(selfProfile.workflows ?? []).map((w, i) => (
                      <p key={i} className="text-gray-300 text-[10px]">- {w}</p>
                    ))}
                  </div>
                </div>

                <div className="bg-gray-900 rounded-lg p-2.5">
                  <p className="text-gray-500 text-[10px] mb-2 font-semibold uppercase tracking-wider">系统限制</p>
                  <div className="space-y-1 text-[10px] text-gray-300">
                    <p>- 最大工具循环：{selfProfile.limits?.maxToolCycles ?? "?"}</p>
                    <p>- 高风险需审批：{selfProfile.limits?.requiresApprovalForHighRisk ? "是" : "否"}</p>
                    <p>- 只读模式：{selfProfile.limits?.readOnlyMode ? "是" : "否"}</p>
                    <p>- 外部任务超时上限：{selfProfile.limits?.externalAgentTimeoutMaxMs ?? "?"} ms</p>
                  </div>
                </div>

                <div className="bg-gray-900 rounded-lg p-2.5">
                  <p className="text-gray-500 text-[10px] mb-2 font-semibold uppercase tracking-wider">记忆参数</p>
                  <div className="space-y-1 text-[10px] text-gray-300">
                    <p>- 语义召回 TopK：{selfProfile.memory?.topK ?? "?"}</p>
                    <p>- 熵减周期：每 {selfProfile.memory?.entropyEvery ?? "?"} 次交互</p>
                  </div>
                </div>
              </div>
            ) : <p className="text-gray-500 text-center py-4">加载中...</p>}
          </>
        )}
      </div>
    </div>
  );
}
