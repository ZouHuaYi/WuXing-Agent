// server.js
// WuXing-Agent Web 网关 —— Express + SSE
//
// 启动：node server.js（或 npm run web）
// 前端地址：http://localhost:3001（由 web/ 目录 Vite 开发服务器提供，代理到 3000）
//
import "dotenv/config";
import express         from "express";
import cors            from "cors";
import { createServer } from "http";
import { WebSocketServer } from "ws";
import { readFileSync, existsSync, readdirSync, statSync, rmSync } from "fs";
import { resolve, join } from "path";

import { agentBus }    from "./src/engine/eventBus.js";
// wuxingGraph 导出: app (CompiledGraph), wisdomMemory, vectorMemory
import { app as compiledApp, wisdomMemory, vectorMemory } from "./src/engine/wuxingGraph.js";
import { skillManager }   from "./src/engine/skillManager.js";
import { goalTracker }    from "./src/engine/goalTracker.js";
import { statusBoard }    from "./src/engine/statusBoard.js";
import { geneticEvolver } from "./src/engine/evolve.js";
import { sessionManager } from "./src/engine/sessionManager.js";
import { approvalManager } from "./src/engine/approvalManager.js";
import { terminalTaskManager } from "./src/engine/terminalController.js";
import { routeIntent, buildDirectReply } from "./src/engine/intentRouter.js";
import { auditAssets } from "./src/engine/assetAuditor.js";
import { queryExperienceUnified, recordExperienceUnified, listRecentExperience } from "./src/engine/experienceCache.js";
import { HumanMessage, AIMessage } from "@langchain/core/messages";
import cfg from "./config/wuxing.json" with { type: "json" };

// compiledApp 已在顶部 import 时初始化

// ── Express ───────────────────────────────────────────────
const app  = express();
const PORT = process.env.WEB_PORT ?? 3000;

app.use(cors({ origin: "*" }));
app.use(express.json({ limit: "2mb" }));

// 静态文件（生产模式下服务 web/dist）
const DIST = resolve(process.cwd(), "web/dist");
if (existsSync(DIST)) {
    app.use(express.static(DIST));
}

function resetRuntimeData({ clearWorkspace = true, clearGoals = true } = {}) {
    const removed = [];
    const removeIfExists = (targetPath) => {
        if (!existsSync(targetPath)) return;
        rmSync(targetPath, { recursive: true, force: true });
        removed.push(targetPath);
    };

    // 1) 会话：清空磁盘会话文件
    sessionManager.clear();
    removeIfExists(resolve(process.cwd(), "data/sessions/current.json"));

    // 2) 记忆：清空内存索引 + 落盘文件
    wisdomMemory.rawDocs = [];
    wisdomMemory.vectors = [];
    removeIfExists(resolve(process.cwd(), "data/wisdom.json"));
    removeIfExists(resolve(process.cwd(), "data/wisdom.vec.json"));

    // 3) 状态：清空缺陷记录并重建 STATUS.md
    removeIfExists(resolve(process.cwd(), "data/defects.json"));
    removeIfExists(resolve(process.cwd(), "STATUS.md"));

    // 4) 目标：可选清空 goals（测试期通常期望全新状态）
    if (clearGoals) {
        goalTracker.resetAll?.();
        removeIfExists(resolve(process.cwd(), "data/goals.json"));
    }

    // 5) 工作区：测试阶段通常希望从干净目录开始
    if (clearWorkspace) {
        const wsDir = resolve(process.cwd(), cfg.tools?.workspaceDir ?? "workspace");
        if (existsSync(wsDir)) {
            for (const name of readdirSync(wsDir)) {
                removeIfExists(join(wsDir, name));
            }
        }
    }

    const allNames = skillManager.getAllTools().map((t) => t.name);
    statusBoard.refresh(allNames);

    return {
        ok: true,
        removedCount: removed.length,
        removed,
        memoryCount: wisdomMemory.getAllDocs().length,
        workspaceCleared: clearWorkspace,
        goalsCleared: clearGoals,
    };
}

function classifyCommandRisk(cmd) {
    const normalized = cmd.trim();
    if (normalized.startsWith(":reset")) {
        return { risk: "critical", actionType: "data_reset", message: "请求执行全量数据重置" };
    }
    if (normalized === ":evolve apply") {
        return { risk: "critical", actionType: "mutate_architecture", message: "请求应用架构基因重构提案" };
    }
    if (normalized === ":goal reset") {
        return { risk: "high", actionType: "goal_reset", message: "请求清空全部目标" };
    }
    if (normalized === ":evolve rollback") {
        return { risk: "high", actionType: "mutate_architecture", message: "请求回滚核心架构文件" };
    }
    if (normalized.includes(" rm ") || normalized.includes(" del ") || normalized.includes(" rd ")) {
        return { risk: "critical", actionType: "shell_execute", message: "疑似危险 shell 删除指令" };
    }
    return { risk: "low", actionType: "command", message: "常规命令" };
}

function loadMcpServers() {
    try {
        const mcpPath = resolve(process.cwd(), "config/mcp.json");
        if (!existsSync(mcpPath)) return [];
        const parsed = JSON.parse(readFileSync(mcpPath, "utf-8"));
        const obj = parsed?.mcpServers ?? {};
        return Object.keys(obj);
    } catch {
        return [];
    }
}

function buildSelfProfile() {
    const skillSnapshot = skillManager.status?.() ?? {
        builtin: [], dynamic: [], mcp: [], mcpStatus: [], total: 0,
    };
    return {
        capabilities: {
            builtinTools: skillSnapshot.builtin ?? [],
            dynamicTools: skillSnapshot.dynamic ?? [],
            mcpTools: skillSnapshot.mcp ?? [],
            mcpServersConfigured: loadMcpServers(),
            totalTools: skillSnapshot.total ?? 0,
        },
        workflows: [
            "water -> intuition -> reasoning <-> tools -> reflection",
            "approval gateway for high risk actions",
            "external expert terminal orchestration",
        ],
        limits: {
            maxToolCycles: cfg.tools?.maxCycles ?? 25,
            externalAgentTimeoutMaxMs: 3_600_000,
            readOnlyMode: false,
            requiresApprovalForHighRisk: true,
        },
        memory: {
            topK: cfg.memory?.topK ?? 5,
            entropyEvery: cfg.memory?.entropyTriggerEvery ?? 10,
        },
    };
}

async function executeControlCommand(cmd) {
    let result = "";

    if (cmd === ":reload") {
        await skillManager.refreshSkills?.();
        result = `已重载技能（${skillManager.getAllTools().length} 个）`;
    } else if (cmd === ":status") {
        const allNames = skillManager.getAllTools().map((t) => t.name);
        statusBoard.refresh(allNames);
        result = statusBoard.getContext(800);
    } else if (cmd === ":goals") {
        result = await goalTracker.briefing();
    } else if (cmd.startsWith(":status resolve ")) {
        const keyword = cmd.slice(":status resolve ".length).trim();
        const ok = statusBoard.resolveDefect(keyword);
        result = ok ? `缺陷已标记修复：${keyword}` : `未找到匹配缺陷：${keyword}`;
    } else if (cmd === ":evolve backup") {
        const dest = geneticEvolver.backup("web_manual");
        result = `备份完成：${dest}`;
    } else if (cmd === ":evolve rollback") {
        const r = geneticEvolver.rollback();
        result = r.message;
    } else if (cmd === ":evolve apply") {
        const r = geneticEvolver.apply();
        result = r.message;
    } else if (cmd === ":goal reset") {
        goalTracker.resetAll?.();
        statusBoard.refresh(skillManager.getAllTools().map((t) => t.name));
        result = "目标已清空";
    } else if (cmd.startsWith(":reset")) {
        const keepWorkspace = cmd.includes("--keep-workspace");
        const keepGoals = cmd.includes("--keep-goals");
        const r = resetRuntimeData({
            clearWorkspace: !keepWorkspace,
            clearGoals: !keepGoals,
        });
        result =
            `重置完成：清理 ${r.removedCount} 个数据项，` +
            `记忆库存 ${r.memoryCount}，目标${r.goalsCleared ? "已清空" : "保留"}，` +
            `工作区${r.workspaceCleared ? "已清空" : "保留"}`;
    } else {
        result = `未知指令：${cmd}`;
    }

    return result;
}

// ── SSE：实时思维流 ──────────────────────────────────────
//
// 每个浏览器连接订阅 agentBus 的 * 事件，格式：text/event-stream
// GET /api/stream
app.get("/api/stream", (req, res) => {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();

    // 心跳 ping（防止代理 30s 超时断连）
    const ping = setInterval(() => res.write(": ping\n\n"), 20_000);

    const handler = (event) => {
        res.write(`data: ${JSON.stringify(event)}\n\n`);
    };

    agentBus.on("*", handler);

    req.on("close", () => {
        agentBus.off("*", handler);
        clearInterval(ping);
    });
});

async function handleThinkRequest(req, res) {
    const { message, sessionMessages = [] } = req.body;
    if (!message?.trim()) {
        return res.status(400).json({ error: "message 不能为空" });
    }

    try {
        // 重建消息对象
        const history = sessionMessages.map((m) =>
            m.role === "human" ? new HumanMessage(m.content) : new AIMessage(m.content)
        );
        const selfProfile = buildSelfProfile();
        const route = routeIntent(message, selfProfile);
        const experience = route.requiresPlanning
            ? await queryExperienceUnified(message, { topK: 3, vectorMemory })
            : { hit: false, hits: [], keywords: [] };
        const assetAudit = route.requiresPlanning ? auditAssets(message, { maxResults: 5 }) : null;
        agentBus.push(
            "intent.route",
            "earth",
            `路由判定：${route.tier} / ${route.decision}${route.canSkipExpert ? "（跳过专家）" : "（专家门控）"} / fit=${route.capabilityFit}`,
            {
                tier: route.tier,
                decision: route.decision,
                canSkipExpert: route.canSkipExpert,
                requiresPlanning: route.requiresPlanning,
                capabilityFit: route.capabilityFit,
                capabilityGaps: route.capabilityGaps,
                plan: route.plan,
                anchors: route.anchors,
            }
        );
        if (experience.hit) {
            agentBus.push(
                "experience.hit",
                "wood",
                `命中历史经验 ${experience.hits[0].task?.slice(0, 40)}...`,
                { keywords: experience.keywords, hits: experience.hits }
            );
        }
        if (assetAudit) {
            agentBus.push(
                "asset.audit",
                "water",
                assetAudit.summary,
                {
                    reuseRecommended: assetAudit.reuseRecommended,
                    keywords: assetAudit.keywords,
                    matches: assetAudit.matches,
                }
            );
        }

        const summary = statusBoard.getContext(240);
        const direct = buildDirectReply(message, route, summary);
        if ((route.tier === "L1_QUERY" || route.tier === "L2_OBSERVE") && direct) {
            const finalMessages = [...history, new HumanMessage(message), new AIMessage(direct)];
            sessionManager.saveHistory(finalMessages);
            await recordExperienceUnified({
                task: message,
                tier: route.tier,
                decision: route.decision,
                status: "success",
                note: "direct_reply",
                vectorMemory,
            });
            return res.json({ answer: direct, rule: null, route, assetAudit: null, experience });
        }

        const experienceBlock = experience.hit
            ? (
                `\n[ExperienceCache]\n` +
                `keywords=${JSON.stringify(experience.keywords)}\n` +
                `hits=${JSON.stringify(experience.hits)}\n` +
                `约束：若历史命中项可复用，优先沿用其 assetPath 对应实现，避免重写。\n`
            )
            : "";
        const reuseBlock = assetAudit
            ? (
                `\n[AssetAudit]\n` +
                `reuseRecommended=${assetAudit.reuseRecommended}\n` +
                `summary=${assetAudit.summary}\n` +
                `matches=${JSON.stringify(assetAudit.matches)}\n` +
                `约束：编码前必须先检查上述资产；若已有高匹配（score>=3），优先复用/扩展，禁止无理由重写。\n`
            )
            : "";
        const planningBlock = route.requiresPlanning
            ? `\n\n[DecisionNode]\n` +
              `tier=${route.tier}; decision=${route.decision}\n` +
              `先输出 Task Plan(JSON: {"steps":[{"id":"S1","action":"","needsExpert":false}]})，` +
              `优先本地工具，只有复杂编码才可调用外部专家。\n` +
              `Context Anchor:\n` +
              `- cwd: ${route.anchors.cwd}\n` +
              `- recentFailures: ${JSON.stringify(route.anchors.recentFailures)}\n` +
              experienceBlock +
              reuseBlock
            : "";
        const routedMessage = `${message}${planningBlock}`;
        const messages = [...history, new HumanMessage(routedMessage)];

        const maxCycles = cfg.tools?.maxCycles ?? 25;

        const result = await compiledApp.invoke(
            { messages },
            { recursionLimit: maxCycles * 2 + 10 }
        );

        const lastMsg  = result.messages?.[result.messages.length - 1];
        const answer   = result.foundWisdom ?? lastMsg?.content ?? "";

        // 持久化本轮对话
        sessionManager.saveHistory([...messages, new AIMessage(answer)]);
        await recordExperienceUnified({
            task: message,
            tier: route.tier,
            decision: route.decision,
            assetPath: assetAudit?.matches?.[0]?.path || experience?.hits?.[0]?.assetPath || "",
            status: "success",
            note: assetAudit?.reuseRecommended ? "reuse_recommended" : "new_build_or_unknown",
            vectorMemory,
        });

        res.json({ answer, rule: result.rule ?? null, route, assetAudit, experience });
    } catch (e) {
        console.error("[服务器] 推理异常：", e.message);
        res.status(500).json({ error: e.message });
    }
}

// ── POST /api/chat：触发 Agent 推理 ──────────────────────
app.post("/api/chat", handleThinkRequest);

// v1 别名：think
app.post("/api/v1/think", handleThinkRequest);

// ── GET /api/status ───────────────────────────────────────
app.get("/api/status", (req, res) => {
    const STATUS_FILE = resolve(process.cwd(), "STATUS.md");
    const DEFECTS_FILE = resolve(process.cwd(), "data/defects.json");

    const md      = existsSync(STATUS_FILE)  ? readFileSync(STATUS_FILE, "utf-8")  : "";
    const defects = existsSync(DEFECTS_FILE) ? JSON.parse(readFileSync(DEFECTS_FILE, "utf-8")) : { open: [], resolved: [] };
    const summary = statusBoard.getContext(600);

    res.json({ markdown: md, defects, summary });
});

// v1 别名：system status
app.get("/api/v1/system/status", (req, res) => {
    const STATUS_FILE = resolve(process.cwd(), "STATUS.md");
    const DEFECTS_FILE = resolve(process.cwd(), "data/defects.json");
    const md      = existsSync(STATUS_FILE)  ? readFileSync(STATUS_FILE, "utf-8")  : "";
    const defects = existsSync(DEFECTS_FILE) ? JSON.parse(readFileSync(DEFECTS_FILE, "utf-8")) : { open: [], resolved: [] };
    const summary = statusBoard.getContext(600);
    res.json({ markdown: md, defects, summary });
});

// ── GET /api/skills ───────────────────────────────────────
app.get("/api/skills", async (req, res) => {
    await skillManager.refreshSkills?.();
    const tools = skillManager.getAllTools();
    res.json({
        count: tools.length,
        skills: tools.map((t) => ({
            name:        t.name,
            description: t.description?.slice(0, 120) ?? "",
        })),
    });
});

// v1 别名：skills
app.get("/api/v1/skills", async (req, res) => {
    await skillManager.refreshSkills?.();
    const tools = skillManager.getAllTools();
    res.json({
        count: tools.length,
        skills: tools.map((t) => ({
            name:        t.name,
            description: t.description?.slice(0, 120) ?? "",
        })),
    });
});

// ── GET /api/workspace ────────────────────────────────────
app.get("/api/workspace", (req, res) => {
    const dir = resolve(process.cwd(), cfg.tools?.workspaceDir ?? "workspace");
    if (!existsSync(dir)) return res.json({ files: [] });

    const files = readdirSync(dir).map((name) => {
        const full = join(dir, name);
        const stat = statSync(full);
        return {
            name,
            size:  stat.size,
            mtime: stat.mtimeMs,
            isDir: stat.isDirectory(),
        };
    });
    res.json({ files });
});

// ── GET /api/workspace/:filename — 读取文件内容 ──────────
app.get("/api/workspace/:filename", (req, res) => {
    const dir  = resolve(process.cwd(), cfg.tools?.workspaceDir ?? "workspace");
    const safe = req.params.filename.replace(/[/\\]/g, "");  // 防路径穿越
    const full = join(dir, safe);
    if (!full.startsWith(dir) || !existsSync(full)) {
        return res.status(404).json({ error: "文件不存在" });
    }
    res.json({ content: readFileSync(full, "utf-8"), name: safe });
});

// ── GET /api/goals ────────────────────────────────────────
app.get("/api/goals", async (req, res) => {
    const goals   = goalTracker.list();
    const briefing = await goalTracker.briefing();
    res.json({ goals, briefing });
});

// ── GET /api/memory ───────────────────────────────────────
app.get("/api/memory", async (req, res) => {
    await wisdomMemory.loadFromDisk();
    const docs  = wisdomMemory.getAllDocs();
    const stats = vectorMemory.stats?.() ?? {};
    res.json({
        total: docs.length,
        stats,
        recent: docs.slice(-5).map((d) => ({
            task:       d.task?.slice(0, 60)  ?? "",
            rule:       d.rule?.slice(0, 80)  ?? "",
            confidence: d.confidence,
            memory_type: d.memory_type ?? "long_term",
        })),
    });
});

// ── POST /api/reset ────────────────────────────────────────
// 清空测试期运行数据：会话、记忆、状态、（可选）工作区
app.post("/api/reset", (req, res) => {
    try {
        const { clearWorkspace = true, clearGoals = true } = req.body ?? {};
        const result = resetRuntimeData({
            clearWorkspace: !!clearWorkspace,
            clearGoals: !!clearGoals,
        });
        res.json(result);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get("/api/pending-actions", (req, res) => {
    res.json({ items: approvalManager.listPending() });
});

app.get("/api/v1/pending-actions", (req, res) => {
    res.json({ items: approvalManager.listPending() });
});

app.get("/api/v1/approval-policy", (req, res) => {
    res.json(approvalManager.getPolicy());
});

app.get("/api/v1/self-profile", (req, res) => {
    try {
        res.json(buildSelfProfile());
    } catch (e) {
        res.status(500).json({ error: e.message || "获取自我画像失败" });
    }
});

app.get("/api/v1/experience-map", (req, res) => {
    const limit = Math.max(1, Math.min(100, Number(req.query.limit) || 30));
    res.json({ items: listRecentExperience(limit) });
});

app.post("/api/v1/approval-policy", (req, res) => {
    try {
        const { policy = {}, persist = true } = req.body ?? {};
        const updated = approvalManager.setPolicy(policy, { persist: !!persist });
        res.json({ ok: true, policy: updated });
    } catch (e) {
        res.status(400).json({ error: e.message || "策略更新失败" });
    }
});

app.post("/api/v1/approvals/:id/decision", (req, res) => {
    const { id } = req.params;
    const { decision, patchedCommand = "", reason = "" } = req.body ?? {};
    if (!decision) return res.status(400).json({ error: "decision 不能为空" });
    const r = approvalManager.resolveDecision(id, { decision, patchedCommand, reason });
    if (!r.ok) return res.status(404).json({ error: r.error });
    res.json(r);
});

app.post("/api/v1/external-agent/start", (req, res) => {
    try {
        const { agentName, taskPrompt, autoApprove = true, timeoutMs = 600000 } = req.body ?? {};
        if (!agentName?.trim()) return res.status(400).json({ error: "agentName 不能为空" });
        if (!taskPrompt?.trim()) return res.status(400).json({ error: "taskPrompt 不能为空" });
        const task = terminalTaskManager.startTask({
            agentName: agentName.trim(),
            taskPrompt: taskPrompt.trim(),
            autoApprove: !!autoApprove,
            timeoutMs: Math.max(5000, Math.min(3600000, Number(timeoutMs) || 600000)),
        });
        res.json({ task });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get("/api/v1/external-agent/tasks", (req, res) => {
    res.json({ tasks: terminalTaskManager.listTasks() });
});

app.get("/api/v1/external-agent/tasks/:id", (req, res) => {
    const task = terminalTaskManager.getTaskSnapshot(req.params.id);
    if (!task) return res.status(404).json({ error: "任务不存在" });
    res.json({ task });
});

app.post("/api/v1/external-agent/tasks/:id/input", (req, res) => {
    const { text = "" } = req.body ?? {};
    const ok = terminalTaskManager.sendInput(req.params.id, text);
    if (!ok) return res.status(404).json({ error: "任务不存在或不可输入" });
    res.json({ ok: true });
});

app.post("/api/v1/external-agent/tasks/:id/resize", (req, res) => {
    const { cols = 120, rows = 30 } = req.body ?? {};
    const ok = terminalTaskManager.resizeTask(req.params.id, cols, rows);
    if (!ok) return res.status(404).json({ error: "任务不存在或不支持 resize" });
    res.json({ ok: true });
});

app.post("/api/v1/external-agent/tasks/:id/stop", (req, res) => {
    const ok = terminalTaskManager.stopTask(req.params.id);
    if (!ok) return res.status(404).json({ error: "任务不存在" });
    res.json({ ok: true });
});

// ── POST /api/command — REPL 指令封装 ────────────────────
app.post("/api/command", async (req, res) => {
    const { cmd } = req.body;
    if (!cmd) return res.status(400).json({ error: "cmd 不能为空" });

    try {
        const riskMeta = classifyCommandRisk(cmd);
        let effectiveCmd = cmd;
        let approval = null;

        if (approvalManager.shouldRequest(riskMeta.risk)) {
            approval = await approvalManager.requestApproval({
                actionType: riskMeta.actionType,
                risk: riskMeta.risk,
                command: cmd,
                message: riskMeta.message,
                allowModify: true,
                metadata: { source: "web_command" },
            });
            if (!approval.approved) {
                return res.json({ result: `操作已拒绝：${approval.reason || "未获批准"}`, approval });
            }
            effectiveCmd = approval.command || cmd;
        }

        const result = await executeControlCommand(effectiveCmd);
        res.json({ result });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ── SPA fallback ──────────────────────────────────────────
// Express 新版 router 不再支持裸 * 通配符，需用 /{*path}
app.get("/{*path}", (req, res) => {
    const index = join(DIST, "index.html");
    if (existsSync(index)) {
        res.sendFile(index);
    } else {
        res.status(200).send(`
            <h2>WuXing-Agent 后端运行中 🟢</h2>
            <p>前端尚未构建。请进入 web/ 目录执行 npm install && npm run build</p>
            <p>或在开发模式下运行 cd web && npm run dev（Vite 开发服务器在 3001 端口）</p>
        `);
    }
});

function attachWebSocketBridge(httpServer) {
    const wss = new WebSocketServer({ server: httpServer, path: "/ws" });
    const sockets = new Set();

    wss.on("connection", (socket) => {
        sockets.add(socket);
        socket.send(JSON.stringify({
            type: "ws.connected",
            ts: Date.now(),
            message: "WebSocket connected",
        }));
        socket.on("close", () => sockets.delete(socket));
    });

    const handler = (event) => {
        const payload = JSON.stringify(event);
        for (const s of sockets) {
            if (s.readyState === 1) s.send(payload);
        }
    };
    agentBus.on("*", handler);

    return () => {
        agentBus.off("*", handler);
        wss.close();
    };
}

// ── 启动 ─────────────────────────────────────────────────
async function bootstrap() {
    // 预热记忆
    await wisdomMemory.loadFromDisk();
    const allNames = skillManager.getAllTools().map((t) => t.name);
    statusBoard.refresh(allNames);

    const httpServer = createServer(app);
    attachWebSocketBridge(httpServer);
    httpServer.listen(PORT, () => {
        console.log(`\n[五行-Web] 后端服务启动 → http://localhost:${PORT}`);
        console.log(`[五行-Web] SSE 端点 → http://localhost:${PORT}/api/stream`);
        console.log(`[五行-Web] WS 端点  → ws://localhost:${PORT}/ws`);
        console.log(`[五行-Web] 前端开发 → cd web && npm run dev\n`);
    });
}

bootstrap().catch(console.error);
