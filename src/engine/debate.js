// src/engine/debate.js
// 【论道】：双智能体辩论控制器
//
// 哲学原型："独学而无友，则孤陋而寡闻"
// 乾（阳/火）× 坤（阴/金）针对同一任务各提方案，天道居中裁判，合成经得起双方挑战的终极准则
// 论道结晶同步写入双方记忆库，实现群体进化速度 > 个体进化速度
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { ChatOpenAI } from "@langchain/openai";
import { WisdomMemory } from "./vectorStore.js";
import cfg from "../../config/wuxing.json" with { type: "json" };
import { logger, EV } from "../utils/logger.js";

const EV_DEBATE = "论道";

// ─────────────────────────────────────────────
// 辩手：轻量 Agent，有独立记忆，带人格偏向
// ─────────────────────────────────────────────
class DebateAgent {
    constructor(name, persona, memory) {
        this.name    = name;
        this.persona = persona;
        this.memory  = memory;
        this.llm     = new ChatOpenAI({ modelName: cfg.models.reasoning, temperature: 0.8 });
    }

    async propose(task) {
        // 先查自身经验库（直觉）
        const wisdom = await this.memory.recall(task);
        if (wisdom) {
            logger.info(EV_DEBATE, `[${this.name}] 调取经验：${wisdom.slice(0, 40)}...`);
            return wisdom;
        }
        // 经验未覆盖，独立推演
        const res = await this.llm.invoke([
            new SystemMessage(this.persona),
            new HumanMessage(task),
        ]);
        logger.info(EV_DEBATE, `[${this.name}] 推演完毕：${res.content.slice(0, 50)}...`);
        return res.content;
    }
}

// ─────────────────────────────────────────────
// 论道控制器
// ─────────────────────────────────────────────
export class WuxingDebate {
    /**
     * @param {WisdomMemory} memoryQian 乾（激进/火）的记忆库，可与主Agent共享或独立
     * @param {WisdomMemory} memoryKun  坤（稳健/金）的记忆库
     */
    constructor(memoryQian, memoryKun) {
        this.agentQian = new DebateAgent(
            "乾",
            "你是激进的改革者，侧重'火'属性——强调速度、突破、创新。" +
            "请直接给出大胆的核心方案（不超过150字），不要过多铺垫。",
            memoryQian
        );
        this.agentKun = new DebateAgent(
            "坤",
            "你是稳健的守护者，侧重'金'属性——强调安全、合规、风险控制。" +
            "请给出审慎可落地的方案（不超过150字），标注主要风险点。",
            memoryKun
        );
        // 天道裁判：低温度，追求逻辑严密
        this.judge = new ChatOpenAI({ modelName: cfg.models.reasoning, temperature: 0.2 });
    }

    /**
     * 开启一轮论道
     * @param {string} task 辩题（复杂任务或高风险决策）
     * @returns {{ proposalQian, proposalKun, synthesis, conflicts }}
     */
    async startDiscourse(task) {
        const maxWords = cfg.debate.synthesisMaxWords;
        logger.info(EV_DEBATE, `论道开启：${task.slice(0, 45)}...`);
        console.log(`\n${"─".repeat(54)}`);
        console.log(`【论道】${task}`);
        console.log("─".repeat(54));

        // Phase 1：双方同时提案（并行，节省时间）
        const [proposalQian, proposalKun] = await Promise.all([
            this.agentQian.propose(task),
            this.agentKun.propose(task),
        ]);

        console.log(`\n[乾-激进] ${proposalQian}`);
        console.log(`\n[坤-稳健] ${proposalKun}`);

        // Phase 2：天道裁判找冲突点并合道
        const judgeRes = await this.judge.invoke([
            new SystemMessage(
                `你是"天道"裁判，负责对两个方案进行五行平衡审判。请：
1. 指出两方案的核心冲突点（一句话）
2. 给出融合双方优点的终极方案（不超过 ${maxWords} 字）
3. 返回严格JSON（不要markdown包裹）：
{"conflict":"冲突点描述","synthesis":"终极方案","balance_score":0到100}`
            ),
            new HumanMessage(
                `辩题：${task}\n\n乾（激进）方案：${proposalQian}\n\n坤（稳健）方案：${proposalKun}`
            ),
        ]);

        let synthesis = "";
        let conflict  = "";
        let balanceScore = 0;

        try {
            const parsed  = JSON.parse(judgeRes.content.trim());
            synthesis    = parsed.synthesis   ?? judgeRes.content;
            conflict     = parsed.conflict    ?? "未识别";
            balanceScore = parsed.balance_score ?? 0;
        } catch {
            synthesis = judgeRes.content.trim();
            logger.warn(EV_DEBATE, "裁判结果解析失败，以原文作为合道结果。");
        }

        console.log(`\n[冲突点] ${conflict}`);
        console.log(`\n[天道合道 | 五行平衡分: ${balanceScore}]\n${synthesis}`);
        logger.evolution(EV_DEBATE, `合道完成（平衡分 ${balanceScore}）：${synthesis.slice(0, 60)}...`);

        // Phase 3：内丹交换 —— 论道结晶同步写入双方记忆库
        const sharedRule = `[论道结晶] ${synthesis}`;
        const sharedConfidence = +(balanceScore / 100).toFixed(2);

        await Promise.all([
            this.agentQian.memory.memorize(task, sharedRule, sharedConfidence),
            // 只有当两个记忆库不同对象时才写入坤（避免重复写入共享库）
            this.agentKun.memory !== this.agentQian.memory
                ? this.agentKun.memory.memorize(task, sharedRule, sharedConfidence)
                : Promise.resolve(),
        ]);

        logger.info(EV_DEBATE, `论道结晶已写入双方记忆库（置信度 ${sharedConfidence}）`);

        return { proposalQian, proposalKun, synthesis, conflict, balanceScore };
    }
}
