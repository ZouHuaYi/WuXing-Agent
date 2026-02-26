// src/engine/sessionManager.js
// 【水-流动】：持久化会话管理
//
// 职责：
//   1. 跨进程保存 sessionMessages → data/sessions/current.json
//   2. 启动时恢复上一次对话上下文（断点续接）
//   3. 超限时自动 LLM 摘要压缩（土之归藏），防止 Token 爆炸
//
// 消息序列化格式（JSON 数组）：
//   { role: "human" | "ai" | "system", content: string }
//
import { readFileSync, writeFileSync, existsSync, unlinkSync, mkdirSync } from "fs";
import { dirname, resolve } from "path";
import { HumanMessage, AIMessage, SystemMessage } from "@langchain/core/messages";
import { ChatOpenAI } from "@langchain/openai";
import cfg from "../../config/wuxing.json" with { type: "json" };

const sessionCfg = cfg.session ?? {};
const SESSION_FILE        = resolve(process.cwd(), sessionCfg.persistFile   ?? "data/sessions/current.json");
const MAX_MESSAGES        = sessionCfg.maxMessages      ?? 40;   // 超过此数强制压缩
const SUMMARY_KEEP_RECENT = sessionCfg.summaryKeepRecent ?? 10;  // 压缩后保留的最新条数

// ── LLM：仅用于摘要，使用低温度保证稳定性 ────────────────
const summaryLlm = new ChatOpenAI({
    modelName:   cfg.models.reasoning,
    temperature: 0.2,
});

// ── 消息序列化 / 反序列化 ─────────────────────────────────

function serialize(msg) {
    if (msg instanceof HumanMessage)  return { role: "human",  content: String(msg.content) };
    if (msg instanceof AIMessage)     return { role: "ai",     content: String(msg.content) };
    if (msg instanceof SystemMessage) return { role: "system", content: String(msg.content) };
    // 兜底
    return { role: "system", content: String(msg.content ?? "") };
}

function deserialize({ role, content }) {
    if (role === "human")  return new HumanMessage(content);
    if (role === "ai")     return new AIMessage(content);
    return new SystemMessage(content);
}

// ── 核心类 ────────────────────────────────────────────────

export class SessionManager {
    constructor() {
        this._ensureDir();
    }

    _ensureDir() {
        const dir = dirname(SESSION_FILE);
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    }

    // 从磁盘加载上一次会话（返回 LangChain Message 数组）
    loadHistory() {
        if (!existsSync(SESSION_FILE)) return [];
        try {
            const raw  = readFileSync(SESSION_FILE, "utf-8");
            const data = JSON.parse(raw);
            if (!Array.isArray(data)) return [];
            const msgs = data.map(deserialize);
            console.log(`[水-会话] 恢复上一次对话（${msgs.length} 条）`);
            return msgs;
        } catch (e) {
            console.warn(`[水-会话] 会话文件损坏，启动全新对话：${e.message}`);
            return [];
        }
    }

    // 将当前 sessionMessages 持久化（每次对话后调用）
    // 超过 MAX_MESSAGES 时，异步触发 LLM 摘要压缩
    saveHistory(messages) {
        if (messages.length === 0) return;

        const data = messages.map(serialize);
        writeFileSync(SESSION_FILE, JSON.stringify(data, null, 2), "utf-8");

        // 压缩判断：在后台执行，不阻塞主对话流
        if (messages.length > MAX_MESSAGES) {
            setImmediate(() => this._compressAsync(messages));
        }
    }

    // LLM 压缩：将旧消息凝练为 SystemMessage 摘要，保留最新 N 条
    async _compressAsync(messages) {
        try {
            const toSummarize = messages.slice(0, messages.length - SUMMARY_KEEP_RECENT);
            const recent      = messages.slice(-SUMMARY_KEEP_RECENT);

            if (toSummarize.length < 4) return; // 太少不值得压缩

            // 把要压缩的消息转为文本交给 LLM
            const dialogText = toSummarize
                .map((m) => `${m instanceof HumanMessage ? "用户" : "Agent"}：${String(m.content).slice(0, 300)}`)
                .join("\n");

            const res = await summaryLlm.invoke([
                new SystemMessage(
                    "你是一个对话摘要助手。请将以下对话内容压缩为一段简洁的中文摘要（100字以内）。" +
                    "重点保留：任务目标、关键结论、已完成的操作、未解决的问题。不要重复细节。"
                ),
                new HumanMessage(`对话内容：\n${dialogText}`),
            ]);

            const summary = String(res.content).trim();
            const compressed = [
                new SystemMessage(`【历史对话摘要】${summary}`),
                ...recent,
            ];

            // 写回磁盘（压缩版）
            const data = compressed.map(serialize);
            writeFileSync(SESSION_FILE, JSON.stringify(data, null, 2), "utf-8");
            console.log(
                `\n[金-归藏] 会话自动压缩：${messages.length} 条 → ${compressed.length} 条` +
                `（摘要 + 最近 ${SUMMARY_KEEP_RECENT} 条）`
            );
        } catch (e) {
            // 压缩失败不影响主流程，静默处理
        }
    }

    // 清除持久化文件
    clear() {
        if (existsSync(SESSION_FILE)) {
            unlinkSync(SESSION_FILE);
        }
    }

    // 统计信息
    stats(messages) {
        const totalChars = messages.reduce((s, m) => s + String(m.content).length, 0);
        const hasSummary = messages.some((m) => m instanceof SystemMessage);
        return {
            count:     messages.length,
            chars:     totalChars,
            hasSummary,
            persisted: existsSync(SESSION_FILE),
        };
    }
}

// 单例导出
export const sessionManager = new SessionManager();
