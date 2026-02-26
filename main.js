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
import { app, wisdomMemory, vectorMemory, skillWriter } from "./src/engine/wuxingGraph.js";
import { sessionManager } from "./src/engine/sessionManager.js";
import { VisionModule } from "./src/engine/vision.js";
import { EvolutionPlugin } from "./src/plugins/evolution/index.js";
import { WuxingDebate } from "./src/engine/debate.js";
import { WisdomMemory } from "./src/engine/vectorStore.js";
import { skillManager } from "./src/engine/skillManager.js";
import { mcpPool }      from "./src/engine/mcpClient.js";
import { runTeam }      from "./src/engine/orchestrator.js";
import { logger, EV }   from "./src/utils/logger.js";
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
// 启动时从 data/sessions/current.json 恢复（断点续接）
const sessionMessages = [];

function pushSession(humanMsg, aiMsg) {
    sessionMessages.push(humanMsg);
    if (aiMsg) sessionMessages.push(aiMsg);

    // 滑动窗口：超出上限时从头删除最旧的一问一答
    while (sessionMessages.length > cfg.repl.sessionWindowSize) {
        sessionMessages.splice(0, 2);
    }

    // 持久化：每次对话后实时写盘，断电也不怕
    sessionManager.saveHistory(sessionMessages);
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
    console.log("  WuXing-Agent v3.1  五行交互进化系统 + MCP");
    console.log("  状态：感知中...  |  模式：实时生命循环");
    console.log(DOUBLE_DIVIDER);
    console.log("  指令表：");
    console.log("    :v [路径]             - 取象（视觉分析图片）");
    console.log("    :d [主题]             - 论道（双智能体对抗辩论）");
    console.log("    :e                    - 进化（强制梦境折叠 + 熵减）");
    console.log("    :m                    - 状态（查看当前因果律内丹）");
    console.log("    :w / :ls              - 工作区（查看 Agent 产出文件）");
    console.log("    :open                 - 在资源管理器中打开 workspace/ 目录");
    console.log("    :clean [后缀]         - 清理工作区（可按后缀筛选，如 :clean js）");
    console.log("    :skills / :list       - 技能库（查看所有工具，含 MCP 来源）");
    console.log("    :reload               - 热加载（重新扫描 skills/ + 刷新 MCP 工具）");
    console.log("    :install <服务名> <命令> [参数...]");
    console.log("                          - 安装 MCP 服务（写入 mcp.json 并即时连接）");
    console.log("    :config               - 查看 MCP 服务连接状态");
    console.log("");
    console.log("    :team [任务]           - 团队模式（Commander 调度 Executor + Researcher 协作）");
    console.log("    :pin  <准则>           - 钉住核心记忆（永不裁剪）");
    console.log("    :mem                  - 查看分层记忆统计（core/long_term/short_term）");
    console.log("    :grow <任务> <解法>    - 手动触发技能封装（自生长）");
    console.log("    :see  [路径]           - 视觉感知（同 :v，别名）");
    console.log("");
    console.log("    :c                    - 清除会话上下文（内存 + 磁盘）");
    console.log("    :history              - 查看持久化会话状态（轮数、字符、是否已摘要）");
    console.log("    exit                  - 安全退出并保存记忆");
    console.log(DOUBLE_DIVIDER);

    await wisdomMemory.loadFromDisk();
    const count = wisdomMemory.getAllDocs().length;
    logger.info(EV.SYSTEM, `经验库就绪，积累 ${count} 条因果律`);
    console.log(`\n[系统] 经验库就绪，当前积累 ${count} 条因果律`);

    // 水-会话：从磁盘恢复上一次对话上下文（断点续接）
    const prevSession = sessionManager.loadHistory();
    if (prevSession.length > 0) {
        sessionMessages.push(...prevSession);
        console.log(`[水-会话] 已恢复 ${prevSession.length} 条上下文，可继续上次对话`);
    }

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

    // 水-MCP：连接 mcp.json 中已配置的外部服务
    await mcpPool.connectAll();
    const mcpStatus = mcpPool.getStatus();
    const mcpNames  = Object.keys(mcpStatus);
    if (mcpNames.length > 0) {
        const summary = mcpNames.map((n) => {
            const s = mcpStatus[n];
            return s.status === "connected"
                ? `${n}(${s.toolCount})`
                : `${n}[${s.status}]`;
        }).join("、");
        console.log(`[水-MCP] 已连接服务：${summary}`);
        logger.info(EV.WATER, `MCP 服务初始化：${summary}`);
    }

    // 木-技能库初始化（扫描 skills/ 目录 + 挂载 MCP 工具）
    const skillResult = await skillManager.refreshSkills();
    const localCount  = skillResult.tools.length;
    const mcpCount    = skillResult.mcpTools?.length ?? 0;
    if (localCount > 0 || mcpCount > 0) {
        const parts = [];
        if (localCount > 0) parts.push(`本地 ${localCount} 个：${skillResult.tools.join("、")}`);
        if (mcpCount   > 0) parts.push(`MCP ${mcpCount} 个：${skillResult.mcpTools.join("、")}`);
        console.log(`[木-技能] 动态技能已挂载 — ${parts.join("  |  ")}`);
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
        // recursionLimit = maxCycles × 2（reasoning↔tools 每轮2跳）+ 固定节点数（water/intuition/reflection = 3）+ 缓冲
        const maxCycles = cfg.tools?.maxCycles ?? 12;
        const result = await app.invoke(
            { messages: contextMessages },
            { recursionLimit: maxCycles * 2 + 10 }
        );

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

        // 短期记忆：将本轮对话写入 short_term 层（语义可搜索，1天后降权）
        if (answer && input.length > 10) {
            setImmediate(async () => {
                await vectorMemory.add(input, answer, {
                    confidence:   0.5,
                    memory_type:  "short_term",
                });
            });
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
    console.log("\n[木-技能] 正在重新扫描 skills/ + 刷新 MCP 工具...");
    // 重新连接 mcp.json 中尚未连接的服务（已连接的保持）
    await mcpPool.connectAll();
    const result = await skillManager.refreshSkills();
    const local  = result.tools?.length  ?? 0;
    const mcp    = result.mcpTools?.length ?? 0;
    console.log(`[木-技能] 重载完成：本地 ${local} 个，MCP ${mcp} 个（共 ${result.loaded} 个）`);
    if (local > 0) console.log(`  本地技能：${result.tools.join("、")}`);
    if (mcp   > 0) console.log(`  MCP 工具：${result.mcpTools.join("、")}`);
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
    console.log(`[技能库] 共 ${st.total} 个工具`);
    console.log(`  内置工具（${st.builtin.length}）：${st.builtin.join("、")}`);
    if (st.dynamic.length > 0) {
        console.log(`  本地技能（${st.dynamic.length}）：${st.dynamic.join("、")}`);
    }
    if (st.mcp.length > 0) {
        console.log(`  MCP 工具（${st.mcp.length}）：${st.mcp.join("、")}`);
        // 显示每个 MCP 服务来源
        for (const [srvName, srvSt] of Object.entries(st.mcpStatus)) {
            if (srvSt.status === "connected") {
                console.log(`    [${srvName}] ${srvSt.tools.join("、")}`);
            }
        }
    }
    if (Object.keys(st.failed).length > 0) {
        console.log(`  加载失败（${Object.keys(st.failed).length}）：`);
        for (const [name, reason] of Object.entries(st.failed)) {
            console.log(`    ${name} — ${reason}`);
        }
    }
    console.log(`${DIVIDER}\n`);
}

// ─────────────────────────────────────────────
// MCP 指令处理器
// ─────────────────────────────────────────────

/**
 * :install <serverName> <command> [arg1 arg2 ...]
 * 示例：
 *   :install everything npx -y @modelcontextprotocol/server-everything
 *   :install my-server node C:/path/to/server.js
 */
async function handleMcpInstall(argStr) {
    const parts      = argStr.trim().split(/\s+/);
    const serverName = parts[0];
    const command    = parts[1];
    const args       = parts.slice(2);

    if (!serverName || !command) {
        console.log("\n[火-安装] 用法：:install <服务名> <命令> [参数...]");
        console.log("  示例：:install everything npx -y @modelcontextprotocol/server-everything\n");
        return;
    }

    console.log(`\n[火-安装] 正在安装 MCP 服务：${serverName}（${command} ${args.join(" ")}）`);
    console.log("[火-安装] 尝试连接中（可能需要几秒钟）...\n");

    const result = await mcpPool.installServer(serverName, { command, args });

    if (result.success) {
        console.log(`[火-安装] 成功！${serverName} 已连接，提供 ${result.toolCount} 个工具`);
        // 刷新技能库让新工具立即生效
        await skillManager.refreshSkills();
        console.log(`[木-技能] 工具已热载入，可立即使用\n`);
        logger.info(EV.WATER, `MCP 服务安装成功：${serverName}（${result.toolCount} 个工具）`);
    } else {
        console.log(`[火-安装] 连接失败：${result.error}`);
        console.log(`[火-安装] 配置已写入 config/mcp.json，可稍后通过 :reload 重试\n`);
    }
}

/**
 * :config
 * 显示 mcp.json 中所有服务的连接状态
 */
function showMcpConfig() {
    const st     = mcpPool.getStatus();
    const conf   = mcpPool.loadConfig();
    const names  = Object.keys(conf);

    console.log(`\n${DIVIDER}`);
    console.log(`[土-配置] config/mcp.json — 共 ${names.length} 个 MCP 服务`);
    console.log(DIVIDER);

    if (names.length === 0) {
        console.log("  （暂无配置，使用 :install 添加服务）");
    } else {
        for (const name of names) {
            const cfg    = conf[name];
            const status = st[name];
            const icon   = status?.status === "connected" ? "✓" : status?.status === "failed" ? "✗" : "○";
            const cmd    = `${cfg.command} ${(cfg.args ?? []).join(" ")}`;
            console.log(`  ${icon} ${name}`);
            console.log(`    命令：${cmd}`);
            if (cfg.description) console.log(`    说明：${cfg.description}`);
            if (status) {
                if (status.status === "connected") {
                    console.log(`    状态：已连接，${status.toolCount} 个工具（${status.tools.join("、")}）`);
                } else if (status.status === "failed") {
                    console.log(`    状态：连接失败 — ${status.error}`);
                } else {
                    console.log(`    状态：${status.status}`);
                }
            } else {
                console.log("    状态：未尝试连接（重启或 :reload 触发）");
            }
        }
    }
    console.log(`${DIVIDER}\n`);
}

// ─────────────────────────────────────────────
// 分层记忆指令
// ─────────────────────────────────────────────

/**
 * :pin <准则文本>
 * 将一段准则钉入 core 层，永不被认知对齐裁剪
 */
async function handlePinMemory(ruleText) {
    if (!ruleText) {
        console.log("\n[木-记忆] 用法：:pin <准则文本>");
        console.log("  示例：:pin 当涉及路径操作时，必须使用 path.basename 防范路径穿越攻击\n");
        return;
    }
    await vectorMemory.pin(ruleText);
    const stats = vectorMemory.stats();
    console.log(`\n[木-核心] 已钉住准则："${ruleText.slice(0, 60)}"`);
    console.log(`[木-核心] 核心记忆库现有 ${stats.core} 条，总计 ${stats.total} 条\n`);
    logger.info(EV.WOOD, `核心记忆钉住：${ruleText}`);
}

/**
 * :mem
 * 展示分层记忆统计（core / long_term / short_term）
 */
function showLayeredMemoryStats() {
    const stats = vectorMemory.stats();
    console.log(`\n${DIVIDER}`);
    console.log("[木-记忆] 分层记忆统计");
    console.log(DIVIDER);
    console.log(`  核心记忆 (core)       : ${stats.core      ?? 0} 条  ← 永不裁剪`);
    console.log(`  长期记忆 (long_term)  : ${stats.long_term ?? 0} 条`);
    console.log(`  短期记忆 (short_term) : ${stats.short_term ?? 0} 条  ← 超期自动降权`);
    console.log(`  总计                  : ${stats.total} 条`);
    console.log(`${DIVIDER}\n`);
}

/**
 * :grow <任务描述> | <解法描述>
 * 手动触发技能封装。用 "|" 分隔任务和解法。
 * 示例：:grow 计算斐波那契数列 | 用迭代法避免递归栈溢出，时间复杂度 O(n)
 */
async function handleGrow(argStr) {
    const parts    = argStr.split("|").map((s) => s.trim());
    const task     = parts[0];
    const solution = parts[1];

    if (!task || !solution) {
        console.log("\n[木-自生长] 用法：:grow <任务> | <解法>");
        console.log("  示例：:grow 批量重命名文件 | 用 path.basename 提取名称，再 fs.rename 替换\n");
        return;
    }

    console.log(`\n[木-自生长] 正在评估封装价值...（分数阈值：${85}）`);
    const result = await skillWriter.tryWrite(task, solution, 90);  // 手动触发时强制 score=90

    if (result.created) {
        console.log(`[木-自生长] 技能已生成：skills/${result.skillName}/`);
        console.log(`[木-自生长] 使用 :reload 确认加载，或 :skills 查看详情\n`);
        logger.info(EV.WOOD, `手动自生长：${result.skillName}`);
    } else {
        console.log("[木-自生长] LLM 判定此任务不适合封装为通用技能（或已存在同名技能）\n");
    }
}

// ─────────────────────────────────────────────
// 团队协作处理器
// ─────────────────────────────────────────────

/**
 * :team [任务描述]
 * 启动 Supervisor 多智能体模式
 * Commander(土) 调度 Executor(火) 和 Researcher(水) 协作完成任务
 */
async function handleTeam(taskArg) {
    const task = taskArg || "请帮我展示 workspace/ 目录下的文件列表，并分析各文件的用途";

    const TEAM_DIVIDER = "═".repeat(56);
    console.log(`\n${TEAM_DIVIDER}`);
    console.log("  [土-团队] 多智能体协作模式启动");
    console.log(`  任务：${task.slice(0, 60)}${task.length > 60 ? "…" : ""}`);
    console.log(`${TEAM_DIVIDER}\n`);
    logger.info(EV.EARTH, `团队任务启动：${task}`);

    try {
        const result = await runTeam(task);

        console.log(`\n${TEAM_DIVIDER}`);
        console.log("[土-Commander] 最终答案");
        console.log(TEAM_DIVIDER);
        console.log(result);
        console.log(`${TEAM_DIVIDER}\n`);

        // 优质答案也注入单智能体上下文（共享记忆）
        pushSession(new HumanMessage(task), new AIMessage(result));
        setImmediate(() => evolution.afterTask());

    } catch (e) {
        logger.warn(EV.SYSTEM, `团队任务失败：${e.message}`);
        console.error(`\n[错误] 团队模式失败：${e.message}\n`);
    }
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
    sessionManager.clear();
    console.log("\n[系统] 会话上下文已清除（内存 + 磁盘），开始全新对话\n");
}

function showHistory() {
    const s = sessionManager.stats(sessionMessages);
    console.log(`\n[水-会话] 持久化状态`);
    console.log(`  当前轮数 : ${s.count} 条消息`);
    console.log(`  估算字符 : ${s.chars} 字符（约 ${Math.round(s.chars / 4)} tokens）`);
    console.log(`  含摘要   : ${s.hasSummary ? "是（土之归藏已触发）" : "否"}`);
    console.log(`  磁盘状态 : ${s.persisted ? "已持久化 ✓" : "未持久化"}`);
    console.log();
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
        case ":history": showHistory();                     break;
        case ":w":
        case ":ls":      await showWorkspaceStatus();        break;
        case ":clean":   await handleCleanWorkspace(arg);    break;
        case ":open":    await openWorkspaceFolder();        break;
        case ":reload":   await handleReloadSkills();          break;
        case ":skills":
        case ":list":     showSkillStatus();                  break;
        case ":install":  await handleMcpInstall(arg);        break;
        case ":config":   showMcpConfig();                    break;
        case ":team":     await handleTeam(arg);              break;
        case ":pin":      await handlePinMemory(arg);         break;
        case ":mem":      showLayeredMemoryStats();            break;
        case ":grow":     await handleGrow(arg);               break;
        case ":see":      await handleVision(arg);             break;  // :v 别名
        default:          await handleChat(input);            break;
    }

    rl.prompt();
});

rl.on("close", async () => {
    console.log("\n[系统] 正在固化内丹，保存记忆至磁盘...");

    // 水-会话：退出时最终保存（确保最后一条消息落盘）
    if (sessionMessages.length > 0) {
        sessionManager.saveHistory(sessionMessages);
    }

    // 关闭所有 MCP 子进程（防止进程泄漏）
    await mcpPool.disconnectAll();

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
