// src/engine/eventBus.js
// 五行 Agent 思维事件总线 —— 单例 EventEmitter
//
// 各图节点执行时向此总线 emit 带结构的事件，
// server.js 的 SSE 端点订阅这些事件并实时推送给浏览器。
//
// 事件格式：agentBus.emit(type, payload)
//   type    — 见下方 EVENT_TYPES
//   payload — { element, message, data? }
//
import { EventEmitter } from "events";

// ── 事件类型常量 ──────────────────────────────────────────
export const EVENT_TYPES = {
    // 五行节点
    WATER:           "thought:water",       // 水 感知
    FIRE_INTUITION:  "thought:fire_intuition",   // 火 直觉
    EARTH_REASONING: "thought:earth_reasoning",  // 土 推理
    FIRE_ACTION:     "thought:fire_action",      // 火 执行（工具调用）
    METAL_REFLECT:   "thought:metal_reflect",    // 金 反思
    WOOD_MEMORY:     "thought:wood_memory",      // 木 记忆固化

    // 工具层
    TOOL_CALL:       "tool:call",
    TOOL_RESULT:     "tool:result",

    // 流程控制
    ANSWER:          "answer",    // 最终回答完成
    ERROR:           "error",     // 异常
    SYSTEM:          "system",    // 系统通知（初始化、加载等）
};

// ── 颜色/五行元数据（供前端渲染用）────────────────────────
export const ELEMENT_META = {
    water:   { label: "水·感知", color: "#38bdf8", icon: "💧", bg: "#0c2231" },
    fire:    { label: "火·执行", color: "#f97316", icon: "🔥", bg: "#2a1800" },
    earth:   { label: "土·推理", color: "#eab308", icon: "⚖️", bg: "#201a00" },
    metal:   { label: "金·反思", color: "#a8a29e", icon: "⚔️", bg: "#1a1a1a" },
    wood:    { label: "木·记忆", color: "#4ade80", icon: "🌿", bg: "#0a2010" },
    system:  { label: "系统",    color: "#818cf8", icon: "⚙️", bg: "#0f0f1e" },
    tool:    { label: "工具",    color: "#c084fc", icon: "🔧", bg: "#1a0a2e" },
    answer:  { label: "回答",    color: "#34d399", icon: "✨", bg: "#002020" },
};

class AgentEventBus extends EventEmitter {
    constructor() {
        super();
        // 防止超量监听器警告（SSE 可能有多个并发连接）
        this.setMaxListeners(100);
    }

    // 便捷 emit：自动附加时间戳
    push(type, element, message, data = null) {
        const event = {
            type,
            element,   // "water" | "fire" | "earth" | "metal" | "wood" | "tool" | "system"
            message,
            data,
            ts: Date.now(),
        };
        this.emit(type, event);
        this.emit("*", event);   // 通配符：SSE 监听 * 即可接收所有事件
    }
}

export const agentBus = new AgentEventBus();
