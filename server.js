// server.js
// WuXing-Agent Web 网关 —— Express + SSE
//
// 启动：node server.js（或 npm run web）
// 前端地址：http://localhost:3001（由 web/ 目录 Vite 开发服务器提供，代理到 3000）
//
import "dotenv/config";
import express         from "express";
import cors            from "cors";
import { readFileSync, existsSync, readdirSync, statSync } from "fs";
import { resolve, join } from "path";

import { agentBus }    from "./src/engine/eventBus.js";
// wuxingGraph 导出: app (CompiledGraph), wisdomMemory, vectorMemory
import { app as compiledApp, wisdomMemory, vectorMemory } from "./src/engine/wuxingGraph.js";
import { skillManager }   from "./src/engine/skillManager.js";
import { goalTracker }    from "./src/engine/goalTracker.js";
import { statusBoard }    from "./src/engine/statusBoard.js";
import { geneticEvolver } from "./src/engine/evolve.js";
import { sessionManager } from "./src/engine/sessionManager.js";
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

// ── POST /api/chat：触发 Agent 推理 ──────────────────────
app.post("/api/chat", async (req, res) => {
    const { message, sessionMessages = [] } = req.body;
    if (!message?.trim()) {
        return res.status(400).json({ error: "message 不能为空" });
    }

    try {
        // 重建消息对象
        const history = sessionMessages.map((m) =>
            m.role === "human" ? new HumanMessage(m.content) : new AIMessage(m.content)
        );
        const messages = [...history, new HumanMessage(message)];

        const maxCycles = cfg.tools?.maxCycles ?? 25;

        const result = await compiledApp.invoke(
            { messages },
            { recursionLimit: maxCycles * 2 + 10 }
        );

        const lastMsg  = result.messages?.[result.messages.length - 1];
        const answer   = result.foundWisdom ?? lastMsg?.content ?? "";

        // 持久化本轮对话
        sessionManager.saveHistory([...messages, new AIMessage(answer)]);

        res.json({ answer, rule: result.rule ?? null });
    } catch (e) {
        console.error("[服务器] 推理异常：", e.message);
        res.status(500).json({ error: e.message });
    }
});

// ── GET /api/status ───────────────────────────────────────
app.get("/api/status", (req, res) => {
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

// ── POST /api/command — REPL 指令封装 ────────────────────
app.post("/api/command", async (req, res) => {
    const { cmd } = req.body;
    if (!cmd) return res.status(400).json({ error: "cmd 不能为空" });

    try {
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
        } else {
            result = `未知指令：${cmd}`;
        }

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

// ── 启动 ─────────────────────────────────────────────────
async function bootstrap() {
    // 预热记忆
    await wisdomMemory.loadFromDisk();
    const allNames = skillManager.getAllTools().map((t) => t.name);
    statusBoard.refresh(allNames);

    app.listen(PORT, () => {
        console.log(`\n[五行-Web] 后端服务启动 → http://localhost:${PORT}`);
        console.log(`[五行-Web] SSE 端点 → http://localhost:${PORT}/api/stream`);
        console.log(`[五行-Web] 前端开发 → cd web && npm run dev\n`);
    });
}

bootstrap().catch(console.error);
