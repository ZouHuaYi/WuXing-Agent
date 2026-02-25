// src/engine/wuxingGraph.js
// 五行生克循环图（Tool-Calling 升级版）
//
// 新增火-执行环：土（推理）→ 火（工具执行）→ 土（再推理）→ 金（反思）
//
//   水 → 火（直觉）→ 土（推理+工具）⇌ 火（工具执行）→ 金（反思）→ 木（记忆）
//
import { HumanMessage, SystemMessage, ToolMessage } from "@langchain/core/messages";
import { END, START, StateGraph } from "@langchain/langgraph";
import { ChatOpenAI } from "@langchain/openai";
import { WisdomMemory } from "./vectorStore.js";
import { sense } from "./waterSensor.js";
import { prune } from "./entropyReducer.js";
import { ALL_TOOLS } from "./toolBox.js";
import cfg from "../../config/wuxing.json" with { type: "json" };
import { logger, EV } from "../utils/logger.js";

// ── LLM 实例 ─────────────────────────────────────────────
// 反思节点不挂工具，避免在复盘时意外触发工具调用
const llm = new ChatOpenAI({
    modelName:   cfg.models.reasoning,
    temperature: cfg.temperature.reasoning,
});

// 推理节点绑定全部编程工具（土生火：推理触发执行）
const llmWithTools = new ChatOpenAI({
    modelName:   cfg.models.reasoning,
    temperature: cfg.temperature.reasoning,
}).bindTools(ALL_TOOLS);

// 工具名 → 工具实例，执行时快速查找
const TOOL_MAP = Object.fromEntries(ALL_TOOLS.map((t) => [t.name, t]));

export const wisdomMemory = new WisdomMemory();

// 进化计数器（进程生命周期内有效）
let interactionCount = 0;

// ── 状态定义 ─────────────────────────────────────────────
const AgentState = {
    messages:           { value: (x, y) => x.concat(y), default: () => [] },
    environmentContext: { value: (x) => x, default: () => null   },
    foundWisdom:        { value: (x) => x, default: () => null   },
    status:             { value: (x) => x, default: () => ""     },
    // 防止工具调用死循环：记录当前任务累计调用轮次
    toolCallCycles:     { value: (x) => x, default: () => 0      },
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
// 【火-直觉】：向量相似度匹配经验库（快通道）
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
// 【土】：推理节点 —— 携带工具的 System 2 慢思考
//   若模型决定调用工具 → status = "tool_calling"
//   否则直接得出答案  → status = "reflecting"
// ─────────────────────────────────────────────
async function reasoningNode(state) {
    logger.info(EV.EARTH, "启动深层推理（含工具感知）...");
    const ctx = state.environmentContext;

    let systemPrompt =
        "你是具备 MCP 权限的 WuXing 编程专家，可以调用工具来读写文件并执行代码。\n" +
        "当你需要了解文件内容时，先用 list_dir 探路，再用 read_file 精读。\n" +
        "当你要验证代码逻辑时，用 write_file 写入沙箱，再用 execute_code 运行。\n" +
        "工具调用完成后，综合结果给出最终答案，并提炼因果准则。";

    if (ctx?.urgency > 0.7) {
        systemPrompt += "\n用户情绪较为紧迫，请直接给出最核心的3条建议，每条不超过30字。";
    } else if (ctx?.tone === "anxious") {
        systemPrompt += "\n用户有些焦虑，先给予一句共情，再提供可操作建议。";
    } else if (ctx?.tone === "frustrated") {
        systemPrompt += "\n用户感到受挫，避免说教，从理解其处境出发给出务实建议。";
    }

    const res = await llmWithTools.invoke([
        new SystemMessage(systemPrompt),
        ...state.messages,
    ]);

    const hasCalls = res.tool_calls?.length > 0;
    if (hasCalls) {
        logger.info(EV.EARTH,
            `决策：调用工具 [${res.tool_calls.map((c) => c.name).join(", ")}]`
        );
        return {
            messages:       [res],
            status:         "tool_calling",
            toolCallCycles: (state.toolCallCycles ?? 0) + 1,
        };
    }

    logger.info(EV.EARTH, "推理完成，转交金层审计...");
    return { messages: [res], status: "reflecting" };
}

// ─────────────────────────────────────────────
// 【火-执行】：工具执行节点（土生火 → 火生土循环）
//   并行执行本轮全部工具调用，将 ToolMessage 追加到消息链
// ─────────────────────────────────────────────
async function fireToolNode(state) {
    const lastMsg = state.messages[state.messages.length - 1];
    const calls   = lastMsg.tool_calls ?? [];

    console.log(`\n   [火-执行] 调用 ${calls.length} 个工具: ${calls.map((c) => c.name).join(", ")}`);
    logger.info(EV.FIRE, `工具执行：${calls.map((c) => `${c.name}(${JSON.stringify(c.args).slice(0, 60)})`).join(" | ")}`);

    const results = await Promise.all(
        calls.map(async (call) => {
            const toolFn = TOOL_MAP[call.name];
            if (!toolFn) {
                return new ToolMessage({
                    content:      `【错误】未知工具：${call.name}`,
                    tool_call_id: call.id,
                    name:         call.name,
                });
            }
            let output;
            try {
                output = await toolFn.invoke(call.args);
            } catch (e) {
                output = `【工具异常】${e.message}`;
            }
            logger.info(EV.FIRE, `  ← ${call.name}: ${String(output).slice(0, 80)}...`);
            return new ToolMessage({
                content:      String(output),
                tool_call_id: call.id,
                name:         call.name,
            });
        })
    );

    // 结果注入消息链，然后返回土层继续推理（水生木，木生火 闭环）
    return { messages: results, status: "reasoning" };
}

// ─────────────────────────────────────────────
// 【金】：反思与修剪节点 —— 提炼因果律 + 触发熵减
// ─────────────────────────────────────────────
const REFLECTION_PROMPT =
    "对以下解决方案进行因果质量审计，返回严格的JSON对象（不要任何markdown包裹）：\n" +
    '{"rule":"不超过50字的通用因果准则（以【当...时，应...】表达），若无法提炼则填null",' +
    '"score":0到100的整数（综合适用性、因果强度、逻辑严密度），' +
    '"applicability":"广泛|中等|狭窄",' +
    '"causal_strength":0到100的整数}';

async function reflectionNode(state) {
    logger.info(EV.METAL, "正在进行因果质量审计...");
    interactionCount++;

    const userTask = state.messages[0].content;
    // 找到最后一条 AI 的文字回复（跳过 ToolMessage）
    const lastAns = [...state.messages]
        .reverse()
        .find((m) => m._getType?.() === "ai" && typeof m.content === "string" && m.content.trim())
        ?.content ?? "";

    let rule = null;
    let confidence = 0;

    try {
        const evaluation = await llm.invoke([
            new SystemMessage(REFLECTION_PROMPT),
            new HumanMessage(lastAns),
        ]);

        const parsed   = JSON.parse(evaluation.content.trim());
        const score    = Number(parsed.score ?? 0);
        const threshold = cfg.reflection.qualityThreshold;

        if (parsed.rule && score >= threshold) {
            rule       = parsed.rule;
            confidence = +(score / 100).toFixed(2);
            logger.info(EV.METAL,
                `因果评审通过 [${score}分 ≥ ${threshold}] | 适用:${parsed.applicability} | 因果强度:${parsed.causal_strength}`
            );
        } else if (!parsed.rule) {
            logger.info(EV.METAL, "审计：无可提炼的通用准则，跳过入库。");
        } else {
            logger.info(EV.METAL, `审计未通过 [${score}分 < ${threshold}]，逻辑质量不足，不写入记忆。`);
        }
    } catch {
        // JSON 解析失败时走降级路径
        const raw = (await llm.invoke([
            new SystemMessage(
                "请将以下解决方案提炼为不超过50字的通用因果准则（以【当...时，应...】句式）。" +
                "如果无法提炼，只回复【忽略】。"
            ),
            new HumanMessage(lastAns),
        ])).content.trim();

        if (raw !== "【忽略】") {
            rule       = raw;
            confidence = 0.6;
            logger.warn(EV.METAL, "JSON 解析失败，已降级为纯文本提炼。");
        }
    }

    if (rule) {
        await wisdomMemory.memorize(userTask, rule, confidence);
    }

    // 金克木：每 N 次交互触发熵减修剪
    if (interactionCount % cfg.memory.entropyTriggerEvery === 0) {
        logger.info(EV.ENTROPY, `第 ${interactionCount} 次交互，触发定期熵减...`);
        await prune(wisdomMemory);
    }

    return { status: "completed" };
}

// ─────────────────────────────────────────────
// 路由函数
// ─────────────────────────────────────────────

// 直觉层之后：命中 → END；未命中 → 推理
function afterIntuition(state) {
    return state.status === "completed" ? END : "reasoning";
}

// 推理层之后：需要工具且未超限 → 执行；否则 → 反思
function afterReasoning(state) {
    if (state.status === "tool_calling") {
        const cycles = state.toolCallCycles ?? 0;
        if (cycles >= cfg.tools.maxCycles) {
            logger.warn(EV.METAL,
                `工具调用已达上限 ${cfg.tools.maxCycles} 轮，强制转入反思节点（金之约束）。`
            );
            return "reflection";
        }
        return "tools";
    }
    return "reflection";
}

// ─────────────────────────────────────────────
// 构建五行循环图
// ─────────────────────────────────────────────
const workflow = new StateGraph({ channels: AgentState });

workflow.addNode("water",      waterNode);
workflow.addNode("intuition",  intuitionNode);
workflow.addNode("reasoning",  reasoningNode);
workflow.addNode("tools",      fireToolNode);     // 新增火-执行节点
workflow.addNode("reflection", reflectionNode);

workflow.addEdge(START, "water");
workflow.addEdge("water", "intuition");
workflow.addConditionalEdges("intuition", afterIntuition);
workflow.addConditionalEdges("reasoning", afterReasoning);
workflow.addEdge("tools", "reasoning");            // 火 → 土（执行结果反哺推理）
workflow.addEdge("reflection", END);

export const app = workflow.compile();
