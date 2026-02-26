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
import { VectorMemory } from "../memory/vectorMemory.js";
import { SkillWriter }  from "./skillWriter.js";
import { sense } from "./waterSensor.js";
import { prune } from "./entropyReducer.js";
import { WORKSPACE_DIR } from "./toolBox.js";
import { skillManager } from "./skillManager.js";
import { goalTracker }  from "./goalTracker.js";
import { readdir } from "fs/promises";
import { existsSync } from "fs";
import cfg from "../../config/wuxing.json" with { type: "json" };
import { logger, EV } from "../utils/logger.js";

// ── LLM 实例 ─────────────────────────────────────────────
// 反思节点不挂工具，避免在复盘时意外触发工具调用
const llm = new ChatOpenAI({
    modelName:   cfg.models.reasoning,
    temperature: cfg.temperature.reasoning,
});

// 推理用基础 LLM（不预绑工具，每次调用时动态绑定最新技能集）
const llmBase = new ChatOpenAI({
    modelName:   cfg.models.reasoning,
    temperature: cfg.temperature.reasoning,
});

export const wisdomMemory  = new WisdomMemory();
export const vectorMemory  = new VectorMemory(wisdomMemory);
export const skillWriter   = new SkillWriter(skillManager);  // 自写技能触发器

// 进化计数器（进程生命周期内有效）
let interactionCount = 0;

// ── 状态定义 ─────────────────────────────────────────────
// 归约器签名：reducer(currentValue, newValue) → mergedValue
// 标量字段用 (_, y) => y，确保节点的返回值能覆盖旧值
const AgentState = {
    messages:           { value: (x, y) => x.concat(y), default: () => [] },
    environmentContext: { value: (_, y) => y,           default: () => null },
    foundWisdom:        { value: (_, y) => y,           default: () => null },
    // 直觉命中但不应绕过推理时，将经验作为"策略提示"注入推理层
    wisdomHint:         { value: (_, y) => y,           default: () => null },
    status:             { value: (_, y) => y,           default: () => ""   },
    // 累计调用轮次：节点已自行做加法，归约器直接替换即可
    toolCallCycles:     { value: (_, y) => y,           default: () => 0    },
};

// ── 直觉旁路豁免检测 ─────────────────────────────────────
// 以下场景，即使命中经验库，也必须透传到推理层执行：
//   1. 实时数据类：用户需要当前/今天/最新的事实，缓存经验无法替代
//   2. 行动构建类：用户要求执行、搭建、整合、写代码等操作
// 返回 true 表示"必须绕过直觉短路，强制走推理"
const LIVE_DATA_WORDS  = /今天|今日|现在|当前|最新|实时|此刻|刚才|刚刚|今晚|今早/;
const ACTION_WORDS     = /帮我查|搜索|查询一下|查一下|整合|搭建|创建|写一个|开发|实现|配置|安装|集成|获取|拉取/;

function requiresExecution(query, ctx) {
    // 水层已识别出时序信息，说明问题时效性强
    if (ctx?.temporalHints) return true;
    if (LIVE_DATA_WORDS.test(query))  return true;
    if (ACTION_WORDS.test(query))     return true;
    return false;
}

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
    const ctx       = state.environmentContext;
    const wisdom    = await wisdomMemory.recall(lastInput);

    if (!wisdom) {
        logger.info(EV.FIRE, "经验库未覆盖，转交土层...");
        return { status: "reasoning", wisdomHint: null };
    }

    // 命中经验库，但需要判断是否应该绕过推理
    if (requiresExecution(lastInput, ctx)) {
        // 实时数据 / 行动类查询：将经验作为策略提示注入推理层，不直接返回
        logger.info(EV.FIRE,
            "经验库命中（策略提示），但查询需要实时执行，透传推理层..."
        );
        return { wisdomHint: wisdom, status: "reasoning" };
    }

    // 纯知识型查询（无时效、无操作），直接复用缓存经验
    logger.info(EV.FIRE, "因果律命中，直接输出");
    return { foundWisdom: wisdom, wisdomHint: null, status: "completed" };
}

// ─────────────────────────────────────────────
// 【土】：推理节点 —— 携带工具的 System 2 慢思考
//   若模型决定调用工具 → status = "tool_calling"
//   否则直接得出答案  → status = "reflecting"
// ─────────────────────────────────────────────
// 扫描工作区文件，用于注入系统提示词（水生木：环境感知滋养推理）
async function scanWorkspace() {
    try {
        if (!existsSync(WORKSPACE_DIR)) return [];
        const entries = await readdir(WORKSPACE_DIR, { withFileTypes: true });
        return entries.filter((e) => e.isFile()).map((e) => e.name);
    } catch {
        return [];
    }
}

async function reasoningNode(state) {
    logger.info(EV.EARTH, "启动深层推理（含工具感知）...");
    const ctx = state.environmentContext;

    // 工作区上下文注入
    const wsFiles = await scanWorkspace();
    const wsContext = wsFiles.length > 0
        ? `\n\n【工作区文件 workspace/】：${wsFiles.join("、")}\n` +
          "可直接用文件名引用上述文件（read_file / execute_code / test_runner），无需重新创建。"
        : "\n\n【工作区 workspace/ 当前为空】";

    // 【木-记忆注入】Top-K 分层语义召回，将相关经验注入推理上下文
    const userQuery  = state.messages[state.messages.length - 1]?.content ?? "";
    const memContext = await vectorMemory.buildContext(userQuery, cfg.memory.topK ?? 5);
    const memSection = memContext
        ? `\n\n【相关历史经验（语义召回）】\n${memContext}\n` +
          "以上经验仅供参考，请结合当前问题判断是否适用。"
        : "";

    // 【火-直觉透传】直觉层命中但需要实时执行的经验，作为策略提示注入
    const hintSection = state.wisdomHint
        ? `\n\n【直觉策略提示（请参考，但必须实际执行查询/操作）】\n${state.wisdomHint}`
        : "";

    // 【神-意志注入】将活跃目标写入系统提示，给推理层持续的方向感
    const goalBriefing = await goalTracker.briefing();
    const goalSection  = goalBriefing
        ? `\n\n${goalBriefing}`
        : "";

    const todayStr = new Date().toLocaleDateString("zh-CN", {
        year: "numeric", month: "2-digit", day: "2-digit", weekday: "long",
    });

    let systemPrompt =
        `今天是 ${todayStr}。\n` +
        "你是具备五行自进化能力的 WuXing 编程专家，可以调用工具读写文件、执行代码、并将成果内化为永久技能。\n" +
        "\n" +
        "【标准编程工作流】\n" +
        "  1. list_dir / read_file  — 探路与读取（含 config/mcp.json、config/wuxing.json、skills/*/SKILL.md 等配置）\n" +
        "  2. write_file            — 写入 workspace/\n" +
        "  3. test_runner           — 验证；失败则修复，再验，形成自愈闭环\n" +
        "  4. incorporate_skill     — 测试通过且有复用价值时，将代码提升为 skills/ 正式技能卡并热加载\n" +
        "\n" +
        "【按需装依赖】代码需要第三方包时，先调用 install_npm_package 安装，再写代码。\n" +
        "【自进化原则】测试通过的有价值代码必须调用 incorporate_skill 完成内化，而非仅留在 workspace/。\n" +
        "工具调用完成后，综合结果给出最终答案，并提炼因果准则。" +
        wsContext +
        memSection +
        hintSection +
        goalSection;

    if (ctx?.urgency > 0.7) {
        systemPrompt += "\n用户情绪较为紧迫，请直接给出最核心的3条建议，每条不超过30字。";
    } else if (ctx?.tone === "anxious") {
        systemPrompt += "\n用户有些焦虑，先给予一句共情，再提供可操作建议。";
    } else if (ctx?.tone === "frustrated") {
        systemPrompt += "\n用户感到受挫，避免说教，从理解其处境出发给出务实建议。";
    }

    // 每次推理前动态绑定最新技能集（支持热加载后立即生效）
    const currentTools = skillManager.getAllTools();
    const res = await llmBase.bindTools(currentTools).invoke([
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

    const toolMap = skillManager.getToolMap();  // 每次执行前取最新映射
    const results = await Promise.all(
        calls.map(async (call) => {
            const toolFn = toolMap[call.name];
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

// 安全防御关键词：命中时降低入库门槛（安全准则是高价值内丹）
const SECURITY_KEYWORDS = [
    "path", "traversal", "injection", "xss", "csrf", "sanitize",
    "validate", "encode", "escape", "permission", "privilege",
    "overflow", "crypto", "hash", "jwt", "auth", "sandbox",
    "resolve", "startswith", "basename", "realpath",
];

function detectSecurityContext(text) {
    const lower = text.toLowerCase();
    return SECURITY_KEYWORDS.filter((k) => lower.includes(k));
}

const BASE_REFLECTION_PROMPT =
    "对以下解决方案进行因果质量审计，返回严格的JSON对象（不要任何markdown包裹）：\n" +
    '{"rule":"不超过50字的通用因果准则（以【当...时，应...】表达），若无法提炼则填null",' +
    '"score":0到100的整数（综合适用性、因果强度、逻辑严密度），' +
    '"applicability":"广泛|中等|狭窄",' +
    '"causal_strength":0到100的整数}';

const SECURITY_HINT =
    "\n\n【特别指示】本回答涉及安全防御编码模式。" +
    "安全防御准则（如路径校验、输入过滤、权限边界）是高价值的通用因果律，" +
    "即使适用范围较窄也应积极提炼并给予高分。";

async function reflectionNode(state) {
    logger.info(EV.METAL, "正在进行因果质量审计...");
    interactionCount++;

    const userTask = state.messages[0].content;
    // 找到最后一条 AI 的文字回复（跳过 ToolMessage）
    const lastAns = [...state.messages]
        .reverse()
        .find((m) => m._getType?.() === "ai" && typeof m.content === "string" && m.content.trim())
        ?.content ?? "";

    // 安全上下文检测：综合用户任务 + AI 回答
    const secHits    = detectSecurityContext(userTask + " " + lastAns);
    const isSecurity = secHits.length >= 2; // 至少命中 2 个关键词才视为安全场景
    const threshold  = isSecurity
        ? cfg.reflection.securityThreshold
        : cfg.reflection.qualityThreshold;

    if (isSecurity) {
        logger.info(EV.METAL,
            `检测到安全场景（${secHits.slice(0, 4).join(", ")}），启用安全门槛 [${threshold}分]`
        );
    }

    const reflectionPrompt = BASE_REFLECTION_PROMPT + (isSecurity ? SECURITY_HINT : "");

    let rule = null;
    let confidence = 0;

    try {
        const evaluation = await llm.invoke([
            new SystemMessage(reflectionPrompt),
            new HumanMessage(lastAns),
        ]);

        const parsed = JSON.parse(evaluation.content.trim());
        const score  = Number(parsed.score ?? 0);

        if (parsed.rule && score >= threshold) {
            rule       = parsed.rule;
            confidence = +(score / 100).toFixed(2);
            const tag  = isSecurity ? "[安全准则]" : "";
            logger.info(EV.METAL,
                `因果评审通过 ${tag}[${score}分 ≥ ${threshold}] | 适用:${parsed.applicability} | 因果强度:${parsed.causal_strength}`
            );

            // 【木-自生长】分数足够高时，异步尝试封装为目录型技能卡
            // 用 setImmediate 确保不阻塞当前节点返回
            setImmediate(async () => {
                const { created, skillName } = await skillWriter.tryWrite(userTask, lastAns, score);
                if (created) {
                    console.log(`\n[木-自生长] 新技能已种下：skills/${skillName}/  ← 可用 :skills 查看`);
                }
            });
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

    // 神-意志：反思完成后，异步检查本次任务是否推进了长期目标（不阻塞主流程）
    if (lastAns) {
        setImmediate(async () => {
            try {
                const advanced = await goalTracker.checkTaskRelevance(
                    `任务：${userTask.slice(0, 200)}\n结论：${lastAns.slice(0, 200)}`
                );
                if (advanced) {
                    logger.evolution(EV.SYSTEM,
                        `[神-意志] 长期目标进度更新：${advanced.title} → ${advanced.progress}%`
                    );
                }
            } catch { /* 静默 */ }
        });
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
