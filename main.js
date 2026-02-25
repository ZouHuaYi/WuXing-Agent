// main.js
// WuXing-Agent v3.0 —— 象·数·理 三位一体 + 编程实战（Tool Calling）
// 新增：火-工具执行层 | read_file | write_file | execute_code | list_dir
import "dotenv/config";
import { HumanMessage } from "@langchain/core/messages";
import { app, wisdomMemory } from "./src/engine/wuxingGraph.js";
import { VisionModule } from "./src/engine/vision.js";
import { EvolutionPlugin } from "./src/plugins/evolution/index.js";
import { WuxingDebate } from "./src/engine/debate.js";
import { WisdomMemory } from "./src/engine/vectorStore.js";
import { logger, EV } from "./src/utils/logger.js";
import cfg from "./config/wuxing.json" with { type: "json" };
import { existsSync } from "fs";

const DIVIDER = "─".repeat(54);
const DOUBLE_DIVIDER = "═".repeat(54);

// ─── 阶段一：人情世故助手（五行主流程 + 进化插件）───────
async function phaseOne(evolution) {
    logger.info(EV.SYSTEM, "阶段一启动：五行主流程 —— 人情世故助手");
    console.log("\n【阶段一】五行主流程 —— 人情世故助手");
    console.log(DIVIDER);

    const scenarios = [
        {
            round: 1,
            label: "团队冲突（首次，土-逻辑推演）",
            question: "我的团队成员之间发生了严重冲突，互相指责，项目快推进不下去了，我作为负责人该怎么办？",
        },
        {
            round: 2,
            label: "向上管理（新场景，土-逻辑推演）",
            question: "我和领导的意见不一致，我觉得我的方案更好，但他坚持己见，应该如何处理而不影响关系？",
        },
        {
            round: 3,
            label: "团队内耗（相似场景，预期火-直觉命中）",
            question: "团队又出现了内部争吵，这次因为分工不均，有人认为自己承担了更多工作，情绪激烈，怎么破局？",
        },
    ];

    for (const { round, label, question } of scenarios) {
        console.log(`\n${DIVIDER}`);
        console.log(`【第 ${round} 轮】${label}`);
        console.log(`问题：${question}`);
        console.log(DIVIDER);

        const result = await app.invoke({ messages: [new HumanMessage(question)] });

        const answer = result.foundWisdom ?? result.messages[result.messages.length - 1]?.content;
        const source = result.foundWisdom ? "经验库直觉命中 ✦ 大运流年加权" : "逻辑推演 → 金反思提炼";
        console.log(`\n[来源：${source}]`);
        console.log(`\n${answer ?? "(无输出)"}`);

        // 进化插件钩子：每轮任务完成后调用，插件自行决策是否触发进化
        await evolution.afterTask();
    }
}

// ─── 阶段二：手动触发完整进化周期──────────────────────
async function phaseTwo(evolution) {
    console.log(`\n${DOUBLE_DIVIDER}`);
    console.log("【阶段二】完整进化周期 —— 熵减修剪 + 梦境折叠");
    console.log(DOUBLE_DIVIDER);
    logger.info(EV.SYSTEM, "阶段二：手动触发完整进化周期");
    await evolution.fullCycle();
}

// ─── 阶段三：多模态视觉感知（取象比类）──────────────────
async function phaseThree() {
    console.log(`\n${DOUBLE_DIVIDER}`);
    console.log("【阶段三】多模态取象 —— 视觉信息投入五行推演");
    console.log(DOUBLE_DIVIDER);

    const vision = new VisionModule();

    // 检查是否存在示例图片（用户自备，可以是架构图/监控截图等）
    const sampleImages = [
        "./data/sample.jpg",
        "./data/sample.png",
        "./data/architecture.jpg",
        "./data/architecture.png",
    ];
    const availableImage = sampleImages.find(existsSync);

    if (!availableImage) {
        console.log("[水-视觉] 未找到示例图片（可将图片放至 data/ 目录，命名为 sample.jpg/png）");
        console.log("[水-视觉] 演示：使用文本描述替代图像输入...\n");

        // 用文本模拟取象结果（无需真实图片也能演示后续流程）
        const simulatedVisionOutput =
            "象：一个三层微服务架构图，包含6个服务节点，API网关连接前端，消息队列处于中心位置。" +
            "数：节点数6，连接数9，扇出比约1.5，存在单点依赖（消息队列）。" +
            "理：消息队列是系统瓶颈，一旦故障将导致级联崩溃。建议增加队列冗余或引入熔断机制。";

        console.log(`[水-视觉 模拟] 取象结果：\n${simulatedVisionOutput}\n`);

        console.log("[水-视觉 → 五行] 将视觉感知投入工作流推演...");
        const result = await app.invoke({
            messages: [new HumanMessage(`基于以下系统观察，给出最优处置方案：\n\n${simulatedVisionOutput}`)],
        });

        const answer = result.foundWisdom ?? result.messages[result.messages.length - 1]?.content;
        console.log(`\n[五行推演结果]\n${answer}`);
        return;
    }

    // 真实图片路径
    try {
        const imageDesc = await vision.captureImageLogic(availableImage);
        console.log(`\n[象] 视觉解析结果：\n${imageDesc}\n`);

        console.log("[水-视觉 → 五行] 将取象结果投入工作流推演...");
        const result = await app.invoke({
            messages: [new HumanMessage(`基于观察到的现象：\n\n${imageDesc}\n\n我们应该如何应对？`)],
        });

        const answer = result.foundWisdom ?? result.messages[result.messages.length - 1]?.content;
        const source = result.foundWisdom ? "经验库直觉命中（视觉触发）" : "逻辑推演（视觉场景）";
        console.log(`\n[来源：${source}]\n${answer}`);
    } catch (e) {
        console.warn(`[水-视觉] 取象失败: ${e.message}`);
    }
}

// ─── 阶段四：双智能体论道（乾×坤）──────────────────────
async function phaseFour() {
    console.log(`\n${DOUBLE_DIVIDER}`);
    console.log("【阶段四】乾×坤 双智能体论道");
    console.log("  激进改革者 vs 稳健守护者 → 天道裁判合道");
    console.log(DOUBLE_DIVIDER);
    logger.info(EV.SYSTEM, "阶段四：双智能体论道启动");

    // 乾：共享主 Agent 的记忆库（火属性，激进）
    // 坤：独立记忆库（金属性，稳健）—— 演示内丹交换
    const memoryKun = new WisdomMemory();
    await memoryKun.loadFromDisk(); // 初始也从磁盘恢复，模拟独立进化个体

    const debate = new WuxingDebate(wisdomMemory, memoryKun);

    const debateTopic = "我们团队面临一个高风险的技术重构决策：" +
        "现有系统稳定但技术债严重，全量重写风险大但长期收益高。应如何决策？";

    await debate.startDiscourse(debateTopic);
}

// ─── 阶段五：编程实战（火-执行层）─────────────────────────
async function phaseFive() {
    console.log(`\n${DOUBLE_DIVIDER}`);
    console.log("【阶段五】编程实战 —— 火-工具执行层启动");
    console.log("  土（推理+工具决策）⇌ 火（执行）→ 金（因果审计）");
    console.log(DOUBLE_DIVIDER);
    logger.info(EV.SYSTEM, "阶段五：编程实战 Tool Calling 启动");

    const cases = [
        {
            id: "skill-hardening",
            label: "技能固化：创建并运行斐波那契函数",
            question:
                "请在沙箱中创建一个名为 fib.js 的文件，" +
                "写一个递归斐波那契函数，计算 fib(10) 的值，并运行它。",
        },
        {
            id: "context-awareness",
            label: "上下文感知：分析项目依赖",
            question:
                "先列出项目根目录结构，再读取 package.json，" +
                "分析当前依赖，指出潜在的版本风险或可优化点。",
        },
    ];

    for (const c of cases) {
        console.log(`\n${DIVIDER}`);
        console.log(`[编程 Case] ${c.label}`);
        console.log(`任务：${c.question}`);
        console.log(DIVIDER);

        const result = await app.invoke({ messages: [new HumanMessage(c.question)] });

        const answer = result.foundWisdom ?? result.messages[result.messages.length - 1]?.content;
        console.log(`\n[结果]\n${answer ?? "(无输出)"}`);
        logger.info(EV.SYSTEM, `编程 Case [${c.id}] 完成`);
    }
}

// ─── 主入口 ──────────────────────────────────────────────
async function runSystem() {
    // 初始化进化日志（写入 logs/evolution.log）
    await logger.init(cfg.evolution.logFile);

    console.log(DOUBLE_DIVIDER);
    console.log("  WuXing-Agent  五行智能体框架  v3.0");
    console.log("  象·数·理 | 大运流年 | 梦境合并 | 多模态取象 | 编程执行");
    console.log(DOUBLE_DIVIDER);

    // 木的延续：从磁盘恢复历次进化成果
    await wisdomMemory.loadFromDisk();
    const initialCount = wisdomMemory.getAllDocs().length;
    logger.info(EV.SYSTEM, `经验库就绪，积累 ${initialCount} 条因果律`);
    console.log(`\n[系统] 经验库就绪，当前积累 ${initialCount} 条因果律`);

    // 创建进化插件（钩子式注入，不修改引擎核心）
    const evolution = new EvolutionPlugin(wisdomMemory);

    await phaseOne(evolution);
    await phaseTwo(evolution);
    await phaseThree();
    await phaseFour();
    await phaseFive();

    // 最终进化报告
    const finalDocs = wisdomMemory.getAllDocs();
    console.log(`\n${DOUBLE_DIVIDER}`);
    console.log("【最终进化报告】");
    console.log(`经验库：${initialCount} 条 → ${finalDocs.length} 条`);
    if (finalDocs.length > 0) {
        console.log("\n当前内化的因果律（含大运流年权重）：");
        const now = Date.now();
        finalDocs.forEach((d, i) => {
            const hoursPassed = (now - (d.createdAt ?? now)) / (1000 * 60 * 60);
            const age = hoursPassed < 1 ? "刚刚" : `${hoursPassed.toFixed(1)}h 前`;
            console.log(`  ${i + 1}. [${age}] ${d.result}`);
        });
    }
    // 认知对齐：淘汰低置信度糟粕
    const removed = await wisdomMemory.refreshConfidence();
    if (removed > 0) logger.info(EV.SYSTEM, `认知对齐完成，淘汰 ${removed} 条低质记忆`);

    logger.info(EV.SYSTEM, `本轮进化完毕，经验库 ${initialCount} → ${finalDocs.length} 条`);
    console.log(DOUBLE_DIVIDER);
    console.log(`\n[日志] 进化记录已写入 ${cfg.evolution.logFile}`);
}

runSystem().catch((err) => {
    console.error("[致命错误]", err.message);
    process.exit(1);
});
