// src/engine/orchestrator.js
// 【土-中枢】：Supervisor 多智能体编排器
//
// 角色架构（五行映射）：
//
//   Commander (土) — 中枢大脑：拆解任务、调度团队、汇总结果
//       ↓  transfer_to_executor
//   Executor  (火) — 执行官：文件读写 / 代码执行 / Shell / MCP OS 工具
//       ↓  report_back
//   Researcher (水) — 情报员：信息收集 / 目录探索 / MCP 搜索工具
//       ↓  report_back
//   Commander (土) — 接收报告，决定下一步或输出最终答案
//
// 安全审计（金之约束）：
//   命令在进入 Executor 前通过 auditAction() 检查，
//   危险指令被拦截并返回 Commander 要求修正。
//
import { HumanMessage, AIMessage, SystemMessage, ToolMessage } from "@langchain/core/messages";
import { END, START, StateGraph } from "@langchain/langgraph";
import { ChatOpenAI }             from "@langchain/openai";
import { tool }                   from "@langchain/core/tools";
import { z }                      from "zod";
import { skillManager }           from "./skillManager.js";
import { logger, EV }             from "../utils/logger.js";
import cfg                        from "../../config/wuxing.json"  with { type: "json" };
import agentsCfg                  from "../../config/agents.json"  with { type: "json" };

// ── LLM 实例 ─────────────────────────────────────────────
const llmCommander  = new ChatOpenAI({ modelName: cfg.models.reasoning, temperature: 0.3 });
const llmExecutor   = new ChatOpenAI({ modelName: cfg.models.reasoning, temperature: 0.1 });
const llmResearcher = new ChatOpenAI({ modelName: cfg.models.reasoning, temperature: 0.3 });

const MAX_ITER = agentsCfg.maxIterations ?? 8;

// ── Transfer 工具（Commander 调度专用）────────────────────
const transferToExecutor = tool(
    async () => "已将子任务转交 Executor",
    {
        name:        "transfer_to_executor",
        description: "将需要文件操作、代码执行、Shell 命令的具体子任务转交 Executor（火）处理。",
        schema: z.object({
            subtask:   z.string().describe("给 Executor 的具体指令，包含完整上下文"),
            rationale: z.string().describe("为什么需要 Executor 处理（一句话）"),
        }),
    }
);

const transferToResearcher = tool(
    async () => "已将子任务转交 Researcher",
    {
        name:        "transfer_to_researcher",
        description: "将需要信息收集、目录探索、联网搜索的子任务转交 Researcher（水）处理。",
        schema: z.object({
            subtask:   z.string().describe("给 Researcher 的具体问题或探索方向"),
            rationale: z.string().describe("为什么需要 Researcher 处理（一句话）"),
        }),
    }
);

// ── 安全审计（金之约束）── 内联门卫，不占独立节点 ────────
const DANGER_PATTERNS = [
    /rm\s+-rf/i, /format\s+[a-z]:/i, /del\s+\/[sfq]/i, /rd\s+\/s/i,
    /shutdown/i, /mkfs/i, /dd\s+if=\/dev/i,
    /:(){:|:&};:/,                    // fork bomb
    /net\s+user.*\/add/i,             // 添加系统账户
    /reg\s+delete.*HKLM/i,            // 删除系统注册表
];

function auditAction(subtask) {
    for (const pattern of DANGER_PATTERNS) {
        if (pattern.test(subtask)) {
            return { safe: false, reason: `指令匹配危险模式：${pattern.toString()}` };
        }
    }
    return { safe: true };
}

// ── 状态定义 ─────────────────────────────────────────────
const TeamState = {
    task:      { value: (_, y) => y, default: () => "" },
    messages:  { value: (x, y) => x.concat(y), default: () => [] },
    nextAgent: { value: (_, y) => y, default: () => "" },
    subtask:   { value: (_, y) => y, default: () => "" },
    iterCount: { value: (_, y) => y, default: () => 0  },
    result:    { value: (_, y) => y, default: () => null },
    auditLog:  { value: (x, y) => x.concat(y), default: () => [] },
};

// ── 工具执行辅助（Executor / Researcher 共用）────────────
async function runToolCalls(calls, toolMap) {
    return Promise.all(calls.map(async (call) => {
        const fn = toolMap[call.name];
        if (!fn) {
            return new ToolMessage({
                content: `【错误】未知工具：${call.name}`,
                tool_call_id: call.id, name: call.name,
            });
        }
        let output;
        try {
            output = await fn.invoke(call.args);
        } catch (e) {
            output = `【工具异常】${e.message}`;
        }
        logger.info(EV.FIRE, `  ← ${call.name}: ${String(output).slice(0, 80)}…`);
        return new ToolMessage({
            content: String(output), tool_call_id: call.id, name: call.name,
        });
    }));
}

// ─────────────────────────────────────────────
// 【土】Commander 节点
// ─────────────────────────────────────────────
async function commanderNode(state) {
    logger.info(EV.EARTH, `Commander 第 ${state.iterCount + 1} 轮（任务：${state.task.slice(0, 40)}…）`);
    console.log(`\n[土-Commander] 轮次 ${state.iterCount + 1}，正在拆解任务...`);

    const systemPrompt =
        "你是多智能体团队的指挥官（Commander）。\n" +
        "你的职责：拆解任务，决定下一步由哪个角色执行，最终汇总结果。\n\n" +
        "可用角色：\n" +
        "  - transfer_to_executor：文件读写、代码生成与执行、Shell 命令\n" +
        "  - transfer_to_researcher：信息收集、目录探索、文档搜索\n\n" +
        "如果所有步骤已完成，直接输出最终答案（不调用工具）。\n" +
        "已有进展请参考对话历史，避免重复分配已完成的子任务。";

    const history = state.messages.map((m) => {
        if (m instanceof HumanMessage) return m;
        if (m instanceof AIMessage)    return m;
        return new HumanMessage(`[工具结果] ${m.content}`);
    });

    const taskMsg = new HumanMessage(`任务：${state.task}`);
    const msgs    = [new SystemMessage(systemPrompt), taskMsg, ...history];

    const res = await llmCommander
        .bindTools([transferToExecutor, transferToResearcher])
        .invoke(msgs);

    if (res.tool_calls?.length > 0) {
        const call      = res.tool_calls[0];
        const subtask   = call.args.subtask ?? "";
        const rationale = call.args.rationale ?? "";
        const next      = call.name === "transfer_to_executor" ? "Executor" : "Researcher";

        // 【金之约束】安全审计：在路由 Executor 前检查危险指令
        if (next === "Executor") {
            const audit = auditAction(subtask);
            if (!audit.safe) {
                logger.warn(EV.METAL, `[金-审计] 危险指令被拦截：${audit.reason}`);
                console.log(`\n[金-审计] 危险指令被拦截：${audit.reason}`);
                const blockMsg = new AIMessage(
                    `[安全拦截] 无法执行：${audit.reason}。请重新规划安全的执行方式。`
                );
                return {
                    messages:  [blockMsg],
                    nextAgent: "Commander",
                    auditLog:  [{ subtask, reason: audit.reason, ts: Date.now() }],
                    iterCount: state.iterCount + 1,
                };
            }
        }

        logger.info(EV.EARTH, `Commander → ${next}：${subtask.slice(0, 60)}（${rationale}）`);
        console.log(`[土-Commander] → ${next}：${subtask.slice(0, 60)}`);

        return {
            messages:  [res],
            nextAgent: next,
            subtask,
            iterCount: state.iterCount + 1,
        };
    }

    // 无工具调用 = 最终答案
    logger.info(EV.EARTH, "Commander 输出最终答案");
    console.log("[土-Commander] 任务完成，汇总答案。");
    return {
        messages:  [res],
        nextAgent: "DONE",
        result:    res.content,
        iterCount: state.iterCount + 1,
    };
}

// ─────────────────────────────────────────────
// 【火】Executor 节点
// ─────────────────────────────────────────────
async function executorNode(state) {
    logger.info(EV.FIRE, `Executor 接收子任务：${state.subtask?.slice(0, 60)}`);
    console.log(`\n[火-Executor] 执行：${state.subtask?.slice(0, 60)}`);

    const executorTools  = skillManager.getToolsForRole("Executor");
    const toolMap        = Object.fromEntries(executorTools.map((t) => [t.name, t]));

    const systemPrompt =
        "你是 Executor，负责具体的文件操作与代码执行。\n" +
        "严格按照 Commander 的子任务指示操作，完成后简洁汇报结果。\n" +
        "写完代码后必须用 test_runner 验证；失败时分析错误并修复后重新验证。";

    let messages = [
        new SystemMessage(systemPrompt),
        new HumanMessage(state.subtask),
    ];

    // 最多 3 轮工具调用（防止 Executor 内部死循环）
    for (let round = 0; round < 3; round++) {
        const res = await llmExecutor.bindTools(executorTools).invoke(messages);
        messages.push(res);

        if (!res.tool_calls?.length) break;

        logger.info(EV.FIRE, `  工具调用：${res.tool_calls.map((c) => c.name).join(", ")}`);
        console.log(`   [火-执行] 调用：${res.tool_calls.map((c) => c.name).join(", ")}`);

        const toolResults = await runToolCalls(res.tool_calls, toolMap);
        messages.push(...toolResults);
    }

    // 最后一条 AI 消息作为汇报
    const lastAI = [...messages].reverse().find((m) => m instanceof AIMessage);
    const report = lastAI?.content ?? "(无执行结果)";

    const reportMsg = new AIMessage(`[Executor 汇报] ${report}`);
    return { messages: [reportMsg], nextAgent: "Commander" };
}

// ─────────────────────────────────────────────
// 【水】Researcher 节点
// ─────────────────────────────────────────────
async function researcherNode(state) {
    logger.info(EV.WATER, `Researcher 接收子任务：${state.subtask?.slice(0, 60)}`);
    console.log(`\n[水-Researcher] 探索：${state.subtask?.slice(0, 60)}`);

    const researcherTools = skillManager.getToolsForRole("Researcher");
    const toolMap         = Object.fromEntries(researcherTools.map((t) => [t.name, t]));

    const systemPrompt =
        "你是 Researcher，负责信息收集与目录探索。\n" +
        "只读不写，系统整理发现的信息，最后简洁汇报给 Commander。";

    let messages = [
        new SystemMessage(systemPrompt),
        new HumanMessage(state.subtask),
    ];

    for (let round = 0; round < 2; round++) {
        const res = await llmResearcher.bindTools(researcherTools).invoke(messages);
        messages.push(res);
        if (!res.tool_calls?.length) break;

        const toolResults = await runToolCalls(res.tool_calls, toolMap);
        messages.push(...toolResults);
    }

    const lastAI   = [...messages].reverse().find((m) => m instanceof AIMessage);
    const report   = lastAI?.content ?? "(无收集结果)";
    const reportMsg = new AIMessage(`[Researcher 汇报] ${report}`);
    return { messages: [reportMsg], nextAgent: "Commander" };
}

// ─────────────────────────────────────────────
// 路由函数
// ─────────────────────────────────────────────
function routeFromCommander(state) {
    if (state.iterCount >= MAX_ITER) {
        logger.warn(EV.METAL, `[金-约束] 多智能体达到最大迭代次数 ${MAX_ITER}，强制终止`);
        return END;
    }
    if (state.nextAgent === "Executor")   return "executor";
    if (state.nextAgent === "Researcher") return "researcher";
    return END;  // DONE 或其他
}

// ─────────────────────────────────────────────
// 构建 Team Graph
// ─────────────────────────────────────────────
const teamWorkflow = new StateGraph({ channels: TeamState });

teamWorkflow.addNode("commander",  commanderNode);
teamWorkflow.addNode("executor",   executorNode);
teamWorkflow.addNode("researcher", researcherNode);

teamWorkflow.addEdge(START,        "commander");
teamWorkflow.addConditionalEdges("commander", routeFromCommander);
teamWorkflow.addEdge("executor",   "commander");  // 汇报 → Commander
teamWorkflow.addEdge("researcher", "commander");  // 汇报 → Commander

export const teamApp = teamWorkflow.compile();

/**
 * 便捷入口：传入任务字符串，返回最终结果
 * @param {string} task
 * @returns {Promise<string>}
 */
export async function runTeam(task) {
    const result = await teamApp.invoke({ task, messages: [] });
    return result.result
        ?? result.messages[result.messages.length - 1]?.content
        ?? "(无输出)";
}
