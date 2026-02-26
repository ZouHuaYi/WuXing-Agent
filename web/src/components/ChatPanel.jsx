import React, { useState, useRef, useEffect } from "react";
import ReactMarkdown from "react-markdown";
import { sendChat, startExternalAgent, sendExternalInput, stopExternalTask } from "../lib/api.js";
import { Send, Loader2, Bot, User } from "lucide-react";

function Message({ role, content, isStreaming }) {
  const isAI = role === "ai";
  return (
    <div className={`flex gap-3 ${isAI ? "" : "flex-row-reverse"}`}>
      {/* 头像 */}
      <div className={`shrink-0 w-7 h-7 rounded-full flex items-center justify-center text-xs
        ${isAI ? "bg-indigo-900 text-indigo-300" : "bg-gray-700 text-gray-300"}`}>
        {isAI ? <Bot size={14} /> : <User size={14} />}
      </div>

      {/* 气泡 */}
      <div className={`max-w-[80%] rounded-2xl px-4 py-2.5 text-sm leading-relaxed
        ${isAI
          ? "bg-gray-800 text-gray-100 rounded-tl-sm"
          : "bg-indigo-600 text-white rounded-tr-sm"
        }`}>
        {isAI ? (
          <div className="prose prose-invert prose-sm max-w-none">
            <ReactMarkdown>{content}</ReactMarkdown>
          </div>
        ) : (
          <span className="whitespace-pre-wrap">{content}</span>
        )}
        {isStreaming && (
          <span className="inline-flex items-center gap-1 ml-2 text-indigo-400">
            <Loader2 size={12} className="animate-spin" />
          </span>
        )}
      </div>
    </div>
  );
}

export default function ChatPanel({ thoughts = [] }) {
  const welcome = { role: "ai", content: "☯️ 五行已就绪。我是 WuXing-Agent，你的数字意识体。有什么需要？" };
  const [messages, setMessages] = useState([
    welcome
  ]);
  const [input, setInput]       = useState("");
  const [loading, setLoading]   = useState(false);
  const [activeExternalTask, setActiveExternalTask] = useState(null);
  const bottomRef = useRef(null);
  const inputRef  = useRef(null);
  const seenThoughtIdsRef = useRef(new Set());
  const lastProgressRef = useRef(-1);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  useEffect(() => {
    const resetChat = () => setMessages([welcome]);
    window.addEventListener("wuxing:reset", resetChat);
    return () => window.removeEventListener("wuxing:reset", resetChat);
  }, []);

  function appendExternalLog(taskId, content) {
    setMessages((prev) => {
      const last = prev[prev.length - 1];
      if (last?.meta?.kind === "external_log" && last?.meta?.taskId === taskId) {
        return [
          ...prev.slice(0, -1),
          { ...last, content: `${last.content}${content}` },
        ];
      }
      return [...prev, { role: "ai", content, meta: { kind: "external_log", taskId } }];
    });
  }

  useEffect(() => {
    if (!activeExternalTask) return;
    const taskId = activeExternalTask.id;
    const seen = seenThoughtIdsRef.current;

    for (const t of thoughts) {
      if (!t?.id || seen.has(t.id)) continue;
      seen.add(t.id);
      if (t.data?.taskId !== taskId) continue;

      if (t.type === "terminal.stream") {
        appendExternalLog(taskId, t.data?.chunk ?? "");
        continue;
      }
      if (t.type === "terminal.progress") {
        const p = Number(t.data?.progress ?? 0);
        if (p !== lastProgressRef.current) {
          lastProgressRef.current = p;
          setMessages((prev) => [...prev, { role: "ai", content: `进度：${p}%` }]);
        }
        continue;
      }
      if (t.type === "terminal.prompt") {
        setMessages((prev) => [...prev, {
          role: "ai",
          content: "检测到终端确认提示。可在输入框执行 `/input y` 或 `/input n`。",
        }]);
        continue;
      }
      if (t.type === "terminal.exit") {
        setMessages((prev) => [...prev, {
          role: "ai",
          content: `外部任务结束（exit=${t.data?.code ?? "?"}）。`,
        }]);
        setActiveExternalTask(null);
      }
    }
  }, [thoughts, activeExternalTask]);

  const getSessionMessages = () =>
    messages
      .filter((m) => m.role !== "system")
      .map((m) => ({ role: m.role, content: m.content }));

  const submit = async () => {
    const text = input.trim();
    if (!text || loading) return;

    setInput("");
    setMessages((prev) => [...prev, { role: "human", content: text }]);
    setLoading(true);

    try {
      // 直接在聊天内调用外部专家：
      // /agent codex 实现 xxx
      // /agent codex --manual 实现 xxx
      if (text.startsWith("/agent ")) {
        const body = text.slice("/agent ".length).trim();
        const [agentName, ...restParts] = body.split(" ");
        let rest = restParts.join(" ").trim();
        if (!agentName || !rest) {
          throw new Error("用法：/agent <name> [--manual] <task>");
        }
        let autoApprove = true;
        if (rest.startsWith("--manual ")) {
          autoApprove = false;
          rest = rest.slice("--manual ".length).trim();
        }
        const data = await startExternalAgent({
          agentName,
          taskPrompt: rest,
          autoApprove,
        });
        if (data?.error) throw new Error(data.error);
        const task = data.task;
        if (!task?.id) throw new Error("启动失败：未返回任务ID");
        lastProgressRef.current = -1;
        setActiveExternalTask({ id: task.id, agentName });
        setMessages((prev) => [...prev, {
          role: "ai",
          content: `已启动外部专家任务：${agentName}（task=${task.id}）。日志将实时回流到本对话。`,
        }]);
        return;
      }

      // 手动给外部任务输入：
      // /input y
      if (text.startsWith("/input ")) {
        if (!activeExternalTask?.id) {
          throw new Error("当前没有运行中的外部任务");
        }
        const payload = text.slice("/input ".length);
        await sendExternalInput(activeExternalTask.id, `${payload}\n`);
        setMessages((prev) => [...prev, { role: "ai", content: `已发送输入：${payload}` }]);
        return;
      }

      if (text === "/stop") {
        if (!activeExternalTask?.id) {
          throw new Error("当前没有运行中的外部任务");
        }
        await stopExternalTask(activeExternalTask.id);
        setMessages((prev) => [...prev, { role: "ai", content: "已请求停止外部任务。" }]);
        return;
      }

      const { answer } = await sendChat(text, getSessionMessages());
      setMessages((prev) => [...prev, { role: "ai", content: answer || "(无回应)" }]);
    } catch (e) {
      setMessages((prev) => [...prev, {
        role: "ai",
        content: `⚠️ 推理失败：${e.message}`,
      }]);
    } finally {
      setLoading(false);
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  };

  const handleKey = (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  return (
    <div className="flex flex-col h-full">
      {/* 消息区 */}
      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-4">
        {messages.map((m, i) => (
          <Message key={i} role={m.role} content={m.content}
            isStreaming={loading && i === messages.length - 1 && m.role === "ai"}
          />
        ))}
        {loading && messages[messages.length - 1]?.role === "human" && (
          <div className="flex gap-3">
            <div className="w-7 h-7 rounded-full bg-indigo-900 flex items-center justify-center">
              <Bot size={14} className="text-indigo-300" />
            </div>
            <div className="bg-gray-800 rounded-2xl rounded-tl-sm px-4 py-2.5">
              <Loader2 size={16} className="animate-spin text-indigo-400" />
            </div>
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      {/* 输入栏 */}
      <div className="shrink-0 px-4 pb-4 pt-2 border-t border-gray-800">
        <div className="flex gap-2 items-end bg-gray-800 rounded-2xl px-4 py-2">
          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKey}
            placeholder="提问，或用 /agent codex <任务>、/input y、/stop"
            rows={1}
            className="flex-1 bg-transparent text-sm text-gray-100 placeholder-gray-500
              resize-none outline-none max-h-40 leading-relaxed"
            style={{ minHeight: "24px" }}
            onInput={(e) => {
              e.target.style.height = "24px";
              e.target.style.height = Math.min(e.target.scrollHeight, 160) + "px";
            }}
            disabled={loading}
          />
          <button
            onClick={submit}
            disabled={loading || !input.trim()}
            className="shrink-0 w-8 h-8 rounded-xl bg-indigo-600 hover:bg-indigo-500
              disabled:opacity-40 disabled:cursor-not-allowed
              flex items-center justify-center transition-colors"
          >
            {loading
              ? <Loader2 size={14} className="animate-spin text-white" />
              : <Send size={14} className="text-white" />
            }
          </button>
        </div>
        <p className="text-[10px] text-gray-600 mt-1.5 text-center">
          WuXing-Agent · 自主进化数字意识体
        </p>
      </div>
    </div>
  );
}
