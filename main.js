// main.js —— WuXing-Agent v3.0  交互进化版（REPL）
//
// 运行模式：永续感知循环
//   - 多轮上下文：保留最近 N 轮对话，防止上下文爆炸
//   - 异步进化：每 30 分钟后台梦境折叠，不阻塞对话
//   - 指令系统：:v :d :e :m 按需触发特殊功能
//
import "dotenv/config";
import readline from "readline";
import { HumanMessage, AIMessage } from "@langchain/core/messages";
import { app, wisdomMemory } from "./src/engine/wuxingGraph.js";
import { VisionModule } from "./src/engine/vision.js";
import { EvolutionPlugin } from "./src/plugins/evolution/index.js";
import { WuxingDebate } from "./src/engine/debate.js";
import { WisdomMemory } from "./src/engine/vectorStore.js";
import { skillManager } from "./src/engine/skillManager.js";
import { logger, EV } from "./src/utils/logger.js";
import cfg from "./config/wuxing.json" with { type: "json" };
import { existsSync } from "fs";
import { readdir, unlink, mkdir } from "fs/promises";
import { join } from "path";
import { WORKSPACE_DIR } from "./src/engine/toolBox.js";

const DIVIDER        = "-".repeat(56);
const DOUBLE_DIVIDER = "=".repeat(56);

// ── 多轮会话上下文窗口 ────────────────────────────────────
// 存储 [HumanMessage, AIMessage, HumanMessage, AIMessage ...]
// 最多保留 cfg.repl.sessionWindowSize 条消息（含 Human + AI 双向）
const sessionMessages = [];

function pushSession(humanMsg, aiMsg) {
    sessionMessages.push(humanMsg);
    if (aiMsg) sessionMessages.push(aiMsg);

    // 滑动窗口：超出上限时从头删除最旧的一问一答
    while (sessionMessages.length > cfg.repl.sessionWindowSize) {
        sessionMessages.splice(0, 2);
    }
}

// ── 全局组件 ─────────────────────────────────────────────
const vision   = new VisionModule();
const evolution = new EvolutionPlugin(wisdomMemory);

// ── readline 接口 ─────────────────────────────────────────
const rl = readline.createInterface({
    input:  process.stdin,
    output: process.stdout,
    prompt: "WuXing > ",         // 避免 Windows 控制台 emoji 乱码
    terminal: true,
});

// ─────────────────────────────────────────────
// 启动：初始化 + 后台定时器
// ─────────────────────────────────────────────
async function initSystem() {
    await logger.init(cfg.evolution.logFile);

    console.log(DOUBLE_DIVIDER);
    console.log("  WuXing-Agent v3.0  五行交互进化系统");
    console.log("  状态：感知中...  |  模式：实时生命循环");
    console.log(DOUBLE_DIVIDER);
    console.log("  指令表：");
    console.log("    :v [路径]      - 取象（视觉分析图片）");
    console.log("    :d [主题]      - 论道（双智能体对抗辩论）");
    console.log("    :e             - 进化（强制梦境折叠 + 熵减）");
    console.log("    :m             - 状态（查看当前因果律内丹）");
    console.log("    :w / :ls       - 工作区（查看 Agent 产出文件）");
    console.log("    :open          - 在资源管理器中打开 workspace/ 目录");
    console.log("    :clean [后缀]  - 清理工作区（可按后缀筛选，如 :clean js）");
    console.log("    :skills        - 技能库（查看已挂载的全部工具）");
    console.log("    :reload        - 热加载（重新扫描 skills/ 目录）");
    console.log("");
    console.log("    :c             - 清除当前会话上下文");
    console.log("    exit           - 安全退出并保存记忆");
    console.log(DOUBLE_DIVIDER);

    await wisdomMemory.loadFromDisk();
    const count = wisdomMemory.getAllDocs().length;
    logger.info(EV.SYSTEM, `经验库就绪，积累 ${count} 条因果律`);
    console.log(`\n[系统] 经验库就绪，当前积累 ${count} 条因果律`);

    // 水-感知工作区：启动时一眼看清手头有什么代码产出
    if (!existsSync(WORKSPACE_DIR)) {
        await mkdir(WORKSPACE_DIR, { recursive: true });
    }
    const wsFiles = await listWorkspace();
    if (wsFiles.length > 0) {
        console.log(`[水-工作区] workspace/ 中发现 ${wsFiles.length} 个文件：${wsFiles.join(", ")}`);
        logger.info(EV.WATER, `工作区感知：${wsFiles.join(", ")}`);
    } else {
        console.log("[水-工作区] workspace/ 为空，等待 Agent 产出");
    }
    console.log();

    // 木-技能库初始化（扫描 skills/ 目录，热挂载动态技能）
    const skillResult = await skillManager.refreshSkills();
    if (skillResult.loaded > 0) {
        console.log(`[木-技能] 动态技能已挂载：${skillResult.tools.join("、")}`);
    } else {
        console.log("[木-技能] skills/ 目录暂无技能，内置工具集就绪");
    }
    console.log();

    // 后台梦境定时器（水生木：时间滋养进化）
    const intervalMs = cfg.repl.dreamIntervalMs;
    setInterval(async () => {
        logger.info(EV.SYSTEM, `后台梦境周期启动（每 ${intervalMs / 60000} 分钟）`);
        await evolution.fullCycle();
    }, intervalMs);

    logger.info(EV.SYSTEM, `后台梦境定时器已启动，周期 ${intervalMs / 60000} 分钟`);
    console.log(`[系统] 后台进化定时器已启动（每 ${intervalMs / 60000} 分钟自动梦境折叠）\n`);

    rl.prompt();
}

// ─────────────────────────────────────────────
// 核心对话处理：五行推演 + 多轮上下文
// ─────────────────────────────────────────────
async function handleChat(input) {
    const humanMsg = new HumanMessage(input);

    // 将历史上下文 + 本次输入一并传入工作流
    // 水/直觉节点取最后一条（当前问题），推理节点享有完整会话链
    const contextMessages = [...sessionMessages, humanMsg];

    console.log(`\n[感知] 正在进行五行推演... (上下文 ${sessionMessages.length} 条)\n`);

    try {
        const result = await app.invoke({ messages: contextMessages });

        const answer = result.foundWisdom
            ?? result.messages[result.messages.length - 1]?.content;
        const source = result.foundWisdom
            ? "[火] 直觉命中 — 经验库加权召回"
            : "[土] 逻辑推演 — 实时生成";

        console.log(DIVIDER);
        console.log(source);
        console.log(DIVIDER);
        console.log(answer ?? "(无输出)");
        console.log(`${DIVIDER}\n`);

        // 更新会话窗口（将本轮存入上下文）
        if (answer) {
            pushSession(humanMsg, new AIMessage(answer));
        }

        // 异步微进化：不阻塞主循环，让用户立即看到提示符
        setImmediate(() => evolution.afterTask());

    } catch (err) {
        logger.warn(EV.SYSTEM, `对话异常: ${err.message}`);
        console.error(`\n[错误] 五行推演失败: ${err.message}\n`);
    }
}

// ─────────────────────────────────────────────
// 工作区辅助
// ─────────────────────────────────────────────

async function listWorkspace() {
    try {
        if (!existsSync(WORKSPACE_DIR)) return [];
        const entries = await readdir(WORKSPACE_DIR, { withFileTypes: true });
        return entries.filter((e) => e.isFile()).map((e) => e.name);
    } catch {
        return [];
    }
}

// ─────────────────────────────────────────────
// 指令处理器
// ─────────────────────────────────────────────

async function handleVision(imgPath) {
    const path = imgPath || "./data/sample.jpg";

    if (!existsSync(path)) {
        console.log(`\n[水-视觉] 未找到图片：${path}`);
        console.log("[水-视觉] 请将图片放至 data/ 目录，或用 :v <路径> 指定完整路径\n");
        return;
    }

    try {
        console.log(`\n[水-视觉] 正在解析图片：${path}\n`);
        const desc = await vision.captureImageLogic(path);
        console.log(`[象] ${desc}\n`);

        // 取象结果投入主流程推演
        await handleChat(`基于以下视觉观察，给出分析与决策建议：\n\n${desc}`);
    } catch (e) {
        console.error(`\n[错误] 取象失败: ${e.message}\n`);
    }
}

async function handleDebate(topic) {
    const subject = topic || "如何平衡代码的开发速度与系统稳定性？";

    console.log(`\n[论道] 乾 × 坤 双智能体启动`);
    console.log(`[论道] 论题：${subject}\n`);

    try {
        const memoryKun = new WisdomMemory();
        await memoryKun.loadFromDisk();
        const debate = new WuxingDebate(wisdomMemory, memoryKun);
        await debate.startDiscourse(subject);
    } catch (e) {
        console.error(`\n[错误] 论道失败: ${e.message}\n`);
    }
}

async function handleEvolution() {
    console.log("\n[金] 手动触发深度进化周期（梦境折叠 + 熵减修剪）...\n");
    try {
        await evolution.fullCycle();
        console.log("\n[金] 进化完成\n");
    } catch (e) {
        console.error(`\n[错误] 进化失败: ${e.message}\n`);
    }
}

async function showWorkspaceStatus() {
    const files = await listWorkspace();
    console.log(`\n${DIVIDER}`);
    console.log(`[工作区] workspace/ 共 ${files.length} 个文件`);
    if (files.length === 0) {
        console.log("  （暂无产出，可直接输入编程需求让 Agent 生成代码）");
    } else {
        files.forEach((f, i) => console.log(`  ${i + 1}. ${f}`));
    }
    console.log(`${DIVIDER}\n`);
}

async function handleReloadSkills() {
    console.log("\n[木-技能] 正在重新扫描 skills/ 目录...");
    const result = await skillManager.refreshSkills();
    console.log(`[木-技能] 重载完成：${result.loaded} 个技能已挂载`);
    if (result.tools.length > 0) {
        console.log(`  动态技能：${result.tools.join("、")}`);
    }
    if (result.failed > 0) {
        const st = skillManager.status();
        for (const [name, reason] of Object.entries(st.failed)) {
            console.log(`  [失败] ${name}：${reason}`);
        }
    }
    console.log();
}

function showSkillStatus() {
    const st = skillManager.status();
    console.log(`\n${DIVIDER}`);
    console.log(`[技能库] 共 ${st.total} 个工具（内置 ${st.builtin.length} + 动态 ${st.dynamic.length}）`);
    console.log(`内置工具：${st.builtin.join("、")}`);
    if (st.dynamic.length > 0) {
        console.log(`动态技能：${st.dynamic.join("、")}`);
    }
    if (Object.keys(st.failed).length > 0) {
        console.log(`加载失败：`);
        for (const [name, reason] of Object.entries(st.failed)) {
            console.log(`  ${name} — ${reason}`);
        }
    }
    console.log(`${DIVIDER}\n`);
}

async function openWorkspaceFolder() {
    // Windows: explorer，macOS: open，Linux: xdg-open
    const cmds   = { win32: "explorer", darwin: "open", linux: "xdg-open" };
    const opener = cmds[process.platform] ?? "xdg-open";
    const { exec } = await import("child_process");

    if (!existsSync(WORKSPACE_DIR)) {
        await mkdir(WORKSPACE_DIR, { recursive: true });
    }
    exec(`${opener} "${WORKSPACE_DIR}"`);
    console.log(`\n[系统] 已打开工作区：${WORKSPACE_DIR}\n`);
}

async function handleCleanWorkspace(pattern) {
    const files = await listWorkspace();
    if (files.length === 0) {
        console.log("\n[清理] 工作区已经是空的\n");
        return;
    }

    // 支持按后缀筛选：:clean js  只删除 .js 文件
    const targets = pattern
        ? files.filter((f) => f.endsWith(`.${pattern}`) || f.includes(pattern))
        : files;

    if (targets.length === 0) {
        console.log(`\n[清理] 未找到匹配 "${pattern}" 的文件\n`);
        return;
    }

    console.log(`\n[清理] 即将删除 ${targets.length} 个文件：${targets.join(", ")}`);
    for (const f of targets) {
        await unlink(join(WORKSPACE_DIR, f));
    }
    logger.info(EV.SYSTEM, `工作区清理：删除 ${targets.join(", ")}`);
    console.log(`[清理] 完成，workspace/ 已清洁\n`);
}

function showMemoryStatus() {
    const docs = wisdomMemory.getAllDocs();
    const now  = Date.now();

    console.log(`\n${DIVIDER}`);
    console.log(`[内丹状态] 经验库共 ${docs.length} 条因果律`);
    console.log(DIVIDER);

    if (docs.length === 0) {
        console.log("（暂无记忆，完成几轮对话后将自动积累）");
    } else {
        // 按置信度排序，展示最近 8 条
        const sorted = [...docs].sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0));
        sorted.slice(0, 8).forEach((d, i) => {
            const age = ((now - (d.createdAt ?? now)) / 3600000).toFixed(1);
            const conf = ((d.confidence ?? 0) * 100).toFixed(0);
            const hits = d.hitCount ?? 0;
            console.log(`  ${i + 1}. [道行 ${conf}% | ${age}h前 | 命中${hits}次]`);
            console.log(`     ${d.result.slice(0, 72)}`);
        });
        if (docs.length > 8) {
            console.log(`  ...（另有 ${docs.length - 8} 条）`);
        }
    }

    console.log(`\n[当前会话] 上下文窗口：${sessionMessages.length}/${cfg.repl.sessionWindowSize} 条`);
    console.log(`${DIVIDER}\n`);
}

function clearSession() {
    sessionMessages.length = 0;
    console.log("\n[系统] 会话上下文已清除，开始全新对话\n");
}

// ─────────────────────────────────────────────
// readline 事件绑定：核心调度
// ─────────────────────────────────────────────
rl.on("line", async (line) => {
    const input = line.trim();

    if (!input) {
        rl.prompt();
        return;
    }

    if (input.toLowerCase() === "exit") {
        rl.close();
        return;
    }

    // 指令路由表
    const cmd = input.split(" ")[0];
    const arg = input.slice(cmd.length).trim();

    switch (cmd) {
        case ":v":       await handleVision(arg);            break;
        case ":d":       await handleDebate(arg);            break;
        case ":e":       await handleEvolution();            break;
        case ":m":       showMemoryStatus();                 break;
        case ":c":       clearSession();                     break;
        case ":w":
        case ":ls":      await showWorkspaceStatus();        break;
        case ":clean":   await handleCleanWorkspace(arg);    break;
        case ":open":    await openWorkspaceFolder();        break;
        case ":reload":  await handleReloadSkills();         break;
        case ":skills":  showSkillStatus();                  break;
        default:         await handleChat(input);            break;
    }

    rl.prompt();
});

rl.on("close", async () => {
    console.log("\n[系统] 正在固化内丹，保存记忆至磁盘...");

    // 认知对齐：退出时淘汰低质记忆
    const removed = await wisdomMemory.refreshConfidence();
    if (removed > 0) {
        console.log(`[系统] 认知对齐：淘汰 ${removed} 条低质记忆`);
        logger.info(EV.SYSTEM, `退出时认知对齐，淘汰 ${removed} 条低质记忆`);
    }

    const finalCount = wisdomMemory.getAllDocs().length;
    logger.info(EV.SYSTEM, `系统安全退出，经验库存量 ${finalCount} 条`);
    console.log(`[系统] 安全退出，经验库存量 ${finalCount} 条\n`);
    process.exit(0);
});

// ─────────────────────────────────────────────
// 主入口
// ─────────────────────────────────────────────
initSystem().catch((err) => {
    console.error("[致命错误]", err.message);
    process.exit(1);
});
