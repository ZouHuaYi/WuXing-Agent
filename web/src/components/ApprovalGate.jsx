import React, { useEffect, useMemo, useState } from "react";
import { fetchPendingActions, decideApproval } from "../lib/api.js";

const riskStyle = {
  medium: "text-yellow-300 border-yellow-700/60 bg-yellow-900/20",
  high: "text-orange-300 border-orange-700/60 bg-orange-900/20",
  critical: "text-red-300 border-red-700/60 bg-red-900/20",
};

export default function ApprovalGate({ thoughts = [] }) {
  const [items, setItems] = useState([]);
  const [working, setWorking] = useState(false);
  const [reason, setReason] = useState("");
  const [patched, setPatched] = useState("");

  const current = useMemo(() => items[0] ?? null, [items]);

  async function loadPending() {
    try {
      const data = await fetchPendingActions();
      setItems(data.items ?? []);
    } catch {
      // noop
    }
  }

  useEffect(() => {
    loadPending();
    const timer = setInterval(loadPending, 4000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    const last = thoughts[thoughts.length - 1];
    if (!last) return;
    if (String(last.type || "").startsWith("approval.")) {
      loadPending();
    }
  }, [thoughts]);

  useEffect(() => {
    setReason("");
    setPatched(current?.command || "");
  }, [current?.id]);

  if (!current) return null;

  async function submit(decision) {
    setWorking(true);
    try {
      await decideApproval(current.id, decision, patched, reason);
      await loadPending();
    } finally {
      setWorking(false);
    }
  }

  const riskCls = riskStyle[current.risk] || riskStyle.high;

  return (
    <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4">
      <div className="w-full max-w-2xl bg-gray-950 border border-gray-700 rounded-2xl shadow-xl">
        <div className="px-4 py-3 border-b border-gray-800 flex items-center justify-between">
          <div className="text-sm font-semibold text-gray-100">金之门审批</div>
          <div className={`text-[10px] px-2 py-1 border rounded-full ${riskCls}`}>
            风险等级：{current.risk}
          </div>
        </div>

        <div className="p-4 space-y-3 text-xs">
          <p className="text-gray-300">{current.message || "Agent 请求高风险操作审批"}</p>
          <div className="bg-gray-900 border border-gray-800 rounded-lg p-2">
            <p className="text-[10px] text-gray-500 mb-1">原始指令</p>
            <pre className="text-gray-200 whitespace-pre-wrap break-words">{current.command}</pre>
          </div>

          <div className="bg-gray-900 border border-gray-800 rounded-lg p-2">
            <p className="text-[10px] text-gray-500 mb-1">修改后指令（用于“修改并运行”）</p>
            <textarea
              value={patched}
              onChange={(e) => setPatched(e.target.value)}
              className="w-full h-20 bg-transparent text-gray-100 outline-none resize-y"
            />
          </div>

          <input
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="审批备注（可选）"
            className="w-full px-3 py-2 rounded-lg bg-gray-900 border border-gray-800 text-gray-200 outline-none"
          />
        </div>

        <div className="px-4 py-3 border-t border-gray-800 flex gap-2 justify-end">
          <button
            disabled={working}
            onClick={() => submit("reject")}
            className="px-3 py-1.5 rounded-lg bg-gray-800 hover:bg-gray-700 text-gray-200 text-xs disabled:opacity-50"
          >
            拒绝
          </button>
          <button
            disabled={working}
            onClick={() => submit("modify")}
            className="px-3 py-1.5 rounded-lg bg-yellow-900/40 hover:bg-yellow-800/40 text-yellow-300 text-xs disabled:opacity-50"
          >
            修改并运行
          </button>
          <button
            disabled={working}
            onClick={() => submit("approve")}
            className="px-3 py-1.5 rounded-lg bg-indigo-700 hover:bg-indigo-600 text-white text-xs disabled:opacity-50"
          >
            允许
          </button>
        </div>
      </div>
    </div>
  );
}
