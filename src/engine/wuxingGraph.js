// src/engine/wuxingGraph.js
// 五行生克循环图：水 → 火 → 土 → 金 → 木（闭环进化）
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { END, START, StateGraph } from "@langchain/langgraph";
import { ChatOpenAI } from "@langchain/openai";
import { WisdomMemory } from "./vectorStore.js";
import { sense } from "./waterSensor.js";
import { prune } from "./entropyReducer.js";
import cfg from "../../config/wuxing.json" with { type: "json" };
import { logger, EV } from "../utils/logger.js";

const llm = new ChatOpenAI({
    modelName: cfg.models.reasoning,
    temperature: cfg.temperature.reasoning,
});

export const wisdomMemory = new WisdomMemory();

// 进化计数器（跨调用持久，进程生命周期内有效）
let interactionCount = 0;

// --- 状态定义 ---
const AgentState = {
    messages: { value: (x, y) => x.concat(y), default: () => [] },
    // 水层感知结果：{ tone, urgency, temporalHints }
    environmentContext: { value: (x) => x, default: () => null },
    // 火层命中的因果律
    foundWisdom: { value: (x) => x, default: () => null },
    // 流程控制
    status: { value: (x) => x, default: () => "" },
};

// ─────────────────────────────────────────────
// 【水】：环境感知节点 —— 解析情绪、语气、时序
// ─────────────────────────────────────────────
async function waterNode(state) {
    const lastInput = state.messages[state.messages.length - 1].content;
    console.log("\n[水-感知] 正在解析环境流...");

    const ctx = await sense(lastInput);
    logger.info(EV.WATER,
        `情绪: ${ctx.tone} | 紧迫度: ${ctx.urgency.toFixed(2)}` +
        (ctx.temporalHints ? ` | 时序: ${ctx.temporalHints}` : "")
    );

    return { environmentContext: ctx };
}

// ─────────────────────────────────────────────
// 【火】：直觉节点 —— 向量相似度匹配经验库
// ─────────────────────────────────────────────
async function intuitionNode(state) {
    const lastInput = state.messages[state.messages.length - 1].content;
    const wisdom = await wisdomMemory.recall(lastInput);

    if (wisdom) {
        logger.info(EV.FIRE, "因果律命中，直接输出");
        return { foundWisdom: wisdom, status: "completed" };
    }
    logger.info(EV.FIRE, "经验库未覆盖，转交土层...");
    return { status: "reasoning" };
}

// ─────────────────────────────────────────────
// 【土】：逻辑推演节点 —— System 2 慢思考（受水层影响）
// ─────────────────────────────────────────────
async function reasoningNode(state) {
    logger.info(EV.EARTH, "启动深层推理...");
    const ctx = state.environmentContext;

    // 土克水：用逻辑锚定水层带来的变数
    let systemPrompt = "你是一个具备因果洞察力、深谙人情世故的智慧助手。";
    if (ctx?.urgency > 0.7) {
        systemPrompt += "\n用户情绪较为紧迫，请直接给出最核心的3条建议，每条不超过30字，简明有力。";
    } else if (ctx?.tone === "anxious") {
        systemPrompt += "\n用户有些焦虑，请先用一句话给予共情，再提供具体可操作的建议。";
    } else if (ctx?.tone === "frustrated") {
        systemPrompt += "\n用户感到受挫，请避免说教，从理解其处境出发给出务实建议。";
    } else {
        systemPrompt += "\n请深入分析，给出有层次感的洞察：先识别核心矛盾，再提供具体策略。";
    }

    const res = await llm.invoke([new SystemMessage(systemPrompt), ...state.messages]);
    return { messages: [res], status: "reflecting" };
}

// ─────────────────────────────────────────────
// 【金】：反思与修剪节点 —— 提炼因果律 + 触发熵减
// ─────────────────────────────────────────────
async function reflectionNode(state) {
    logger.info(EV.METAL, "正在提炼因果律...");
    interactionCount++;

    // messages[0] 是初始用户输入，messages[-1] 是 LLM 回复
    const userTask = state.messages[0].content;
    const lastAns = state.messages[state.messages.length - 1].content;

    const evaluation = await llm.invoke([
        new SystemMessage(
            "请将以下解决方案提炼为不超过50字的通用因果准则（去除具体细节，保留普适规律，以【当...时，应...】句式表达）。" +
            "如果该内容无提炼价值或过于具体无法泛化，请只回复【忽略】，不要其他任何文字。"
        ),
        new HumanMessage(lastAns),
    ]);

    const rule = evaluation.content.trim();
    if (rule !== "【忽略】") {
        await wisdomMemory.memorize(userTask, rule);
    } else {
        logger.info(EV.METAL, "本次推理无提炼价值，不写入记忆。");
    }

    // 金克木：每 N 次交互触发熵减修剪（N 从配置读取）
    if (interactionCount % cfg.memory.entropyTriggerEvery === 0) {
        logger.info(EV.ENTROPY, `第 ${interactionCount} 次交互，触发定期熵减...`);
        await prune(wisdomMemory);
    }

    return { status: "completed" };
}

// ─────────────────────────────────────────────
// 构建五行循环图
// ─────────────────────────────────────────────
const workflow = new StateGraph({ channels: AgentState });

workflow.addNode("water", waterNode);
workflow.addNode("intuition", intuitionNode);
workflow.addNode("reasoning", reasoningNode);
workflow.addNode("reflection", reflectionNode);

workflow.addEdge(START, "water");
workflow.addEdge("water", "intuition");
workflow.addConditionalEdges("intuition", (s) =>
    s.status === "completed" ? END : "reasoning"
);
workflow.addEdge("reasoning", "reflection");
workflow.addEdge("reflection", END);

export const app = workflow.compile();
