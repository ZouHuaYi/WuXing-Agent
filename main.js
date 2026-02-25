// main.js
// WuXing-Agent v2.0 —— 象·数·理 三位一体
// 新增：大运流年（时间衰减）| 梦境合并 | 多模态取象
import "dotenv/config";
import { HumanMessage } from "@langchain/core/messages";
import { app, wisdomMemory } from "./src/engine/wuxingGraph.js";
import { DreamModule } from "./src/engine/dream.js";
import { VisionModule } from "./src/engine/vision.js";
import { existsSync } from "fs";

const DIVIDER = "─".repeat(54);
const DOUBLE_DIVIDER = "═".repeat(54);

// ─── 阶段一：人情世故助手（五行主流程）─────────────────
async function phaseOne() {
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
    }
}

// ─── 阶段二：梦境合并（记忆折叠）────────────────────────
async function phaseTwo() {
    console.log(`\n${DOUBLE_DIVIDER}`);
    console.log("【阶段二】梦境合并 —— 碎片因果律聚类折叠");
    console.log(DOUBLE_DIVIDER);
    console.log("系统进入深度自省模式，尝试将多条相似准则合并为高阶「道」...\n");

    const dreamer = new DreamModule(wisdomMemory);
    await dreamer.startDreaming(2); // 至少 2 条即触发（演示用，生产环境建议 ≥ 5）
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

// ─── 主入口 ──────────────────────────────────────────────
async function runSystem() {
    console.log(DOUBLE_DIVIDER);
    console.log("  WuXing-Agent  五行智能体框架  v2.0");
    console.log("  象·数·理 | 大运流年 | 梦境合并 | 多模态取象");
    console.log(DOUBLE_DIVIDER);

    // 木的延续：从磁盘恢复历次进化成果
    await wisdomMemory.loadFromDisk();
    const initialCount = wisdomMemory.getAllDocs().length;
    console.log(`\n[系统] 经验库就绪，当前积累 ${initialCount} 条因果律`);

    await phaseOne();
    await phaseTwo();
    await phaseThree();

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
    console.log(DOUBLE_DIVIDER);
}

runSystem().catch((err) => {
    console.error("[致命错误]", err.message);
    process.exit(1);
});
