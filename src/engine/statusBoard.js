// src/engine/statusBoard.js
// 【金-反射】：自我状态看板（STATUS.md 维护者）
//
// Agent 的自我认知外化为一个人类可读的 Markdown 文件。
// 结构：
//   📅 实时感知   — 当前时间 + 系统状态（来自 awareness.js）
//   🛠️ 能力版图  — 已挂载的工具 + 失败率统计
//   🎯 长期目标   — 来自 goalTracker（最多 3 条活跃）
//   ❌ 待优化缺陷 — 失败教训积累（最多保留 20 条）
//   ✅ 近期修复   — 已标记解决的缺陷（滚动保留 10 条）
//
// 写盘策略：
//   - recordFailure() / resolveDefect()：立即写盘
//   - refresh()：全量重建（在 :status 指令或启动时调用）
//
import {
    readFileSync, writeFileSync, existsSync, mkdirSync
} from "fs";
import { resolve, dirname } from "path";
import { getSnapshot }   from "./awareness.js";
import { goalTracker }   from "./goalTracker.js";
import cfg               from "../../config/wuxing.json" with { type: "json" };

const STATUS_FILE  = resolve(process.cwd(), "STATUS.md");
const DEFECTS_FILE = resolve(process.cwd(), "data/defects.json");
const APPROVAL_AUDIT_FILE = resolve(process.cwd(), "data/audit/approvals.jsonl");
const MAX_DEFECTS  = 20;
const MAX_RESOLVED = 10;

// ── 缺陷数据模型 ────────────────────────────────────────
// { id, task, error, type, at, resolved, resolvedAt, resolvedNote }

function nowStr() {
    return new Date().toLocaleString("zh-CN");
}

function loadDefects() {
    if (!existsSync(DEFECTS_FILE)) return { open: [], resolved: [] };
    try {
        return JSON.parse(readFileSync(DEFECTS_FILE, "utf-8"));
    } catch {
        return { open: [], resolved: [] };
    }
}

function saveDefects(data) {
    const dir = dirname(DEFECTS_FILE);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(DEFECTS_FILE, JSON.stringify(data, null, 2), "utf-8");
}

function loadApprovalAudits(limit = 5) {
    if (!existsSync(APPROVAL_AUDIT_FILE)) return [];
    try {
        const raw = readFileSync(APPROVAL_AUDIT_FILE, "utf-8");
        const lines = raw.split("\n").filter(Boolean);
        const parsed = lines.map((line) => {
            try { return JSON.parse(line); } catch { return null; }
        }).filter(Boolean);
        return parsed.slice(-limit).reverse();
    } catch {
        return [];
    }
}

// ── 主类 ─────────────────────────────────────────────────

export class StatusBoard {

    // ── 记录一次执行失败 ────────────────────────────────
    recordFailure(task, errorDetail, type = "EXECUTION") {
        const data     = loadDefects();
        const shortErr = (errorDetail ?? "").slice(0, 150).replace(/\n/g, " ");

        // 相同任务不重复记录（去重）
        const exists = data.open.some(
            (d) => d.task === task.slice(0, 80)
        );
        if (exists) return;

        const entry = {
            id:       `def_${Date.now().toString(36)}`,
            task:     task.slice(0, 80),
            error:    shortErr,
            type,
            at:       nowStr(),
            resolved: false,
        };

        data.open.unshift(entry);
        // 超出上限时删除最旧的
        if (data.open.length > MAX_DEFECTS) data.open = data.open.slice(0, MAX_DEFECTS);

        saveDefects(data);
        this._writeFile();   // 立即更新 STATUS.md
        return entry;
    }

    // ── 标记一个缺陷已修复 ──────────────────────────────
    resolveDefect(taskKeyword, note = "已修复") {
        const data = loadDefects();
        const idx  = data.open.findIndex((d) =>
            d.task.includes(taskKeyword) || d.id === taskKeyword
        );
        if (idx === -1) return false;

        const [entry] = data.open.splice(idx, 1);
        entry.resolved     = true;
        entry.resolvedAt   = nowStr();
        entry.resolvedNote = note;

        data.resolved.unshift(entry);
        if (data.resolved.length > MAX_RESOLVED) {
            data.resolved = data.resolved.slice(0, MAX_RESOLVED);
        }

        saveDefects(data);
        this._writeFile();
        return true;
    }

    // ── 全量重建 STATUS.md ──────────────────────────────
    refresh(skillList = []) {
        this._skillList = skillList;
        this._writeFile();
    }

    // 使用现有缓存重新写状态文件（用于异步审计追加后刷新）
    touch() {
        this._writeFile();
    }

    // ── 返回适合注入 Prompt 的精简摘要 ─────────────────
    // maxChars 控制长度，防止 Token 爆炸
    getContext(maxChars = 600) {
        const data      = loadDefects();
        const snap      = getSnapshot();
        const active    = goalTracker.list("active").slice(0, 2);
        const openCount = data.open.length;

        const lines = [
            `【自我状态快照 ${snap.date} ${snap.weekday}】`,
            `系统：${snap.platform} | 内存余 ${snap.freeMemMB}MB`,
        ];

        if (active.length > 0) {
            lines.push("活跃目标：" + active.map(
                (g) => `${g.title}（${g.progress}%）`
            ).join("、"));
        }

        if (openCount > 0) {
            lines.push(`待修复缺陷 ${openCount} 条，最新：${data.open[0]?.task}`);
            lines.push("遇到相同问题时请先检查上次失败原因，避免重复踩坑。");
        }

        return lines.join("\n").slice(0, maxChars);
    }

    // ── 内部：写 STATUS.md ──────────────────────────────
    _writeFile() {
        const snap    = getSnapshot();
        const data    = loadDefects();
        const active  = goalTracker.list("active");
        const skills  = this._skillList ?? [];
        const approvals = loadApprovalAudits(5);

        const lines = [
            `# WuXing-Agent 状态看板`,
            `> 由 Agent 自动维护，最后更新：${snap.timestamp}`,
            ``,
            `## 📅 实时感知`,
            `- **时间**：${snap.timestamp}（${snap.weekday}）`,
            `- **平台**：${snap.platform} ${snap.arch} | Node ${snap.nodeVersion}`,
            `- **内存**：已用 ${snap.totalMemMB - snap.freeMemMB} MB / 共 ${snap.totalMemMB} MB`,
            `- **CPU 负载（1m）**：${snap.cpuLoad1m}`,
            ``,
            `## 🛠️ 能力版图`,
        ];

        if (skills.length > 0) {
            // 区分 MCP 工具和本地工具
            const mcpTools   = skills.filter((s) => s.includes("__"));
            const localTools = skills.filter((s) => !s.includes("__"));
            if (localTools.length > 0) {
                lines.push(`- **本地工具（${localTools.length}）**：${localTools.join("、")}`);
            }
            if (mcpTools.length > 0) {
                lines.push(`- **MCP 工具（${mcpTools.length}）**：${mcpTools.join("、")}`);
            }
        } else {
            lines.push("- 工具列表加载中...");
        }

        lines.push("", "## 🎯 长期目标");
        if (active.length > 0) {
            for (const g of active.slice(0, 3)) {
                const bar = "▓".repeat(Math.floor(g.progress / 10)) +
                            "░".repeat(10 - Math.floor(g.progress / 10));
                const dl  = g.deadline ? ` 截止 ${g.deadline}` : "";
                lines.push(`- **[${g.priority.toUpperCase()}] ${g.title}**${dl}`);
                lines.push(`  进度：\`${bar}\` ${g.progress}%`);
                const pending = g.milestones.filter((m) => !m.done);
                if (pending.length > 0) {
                    lines.push(`  下一步：${pending[0].title}`);
                }
            }
        } else {
            lines.push("- 暂无活跃目标（使用 `:vision` 添加）");
        }

        lines.push("", "## ❌ 待优化缺陷");
        if (data.open.length > 0) {
            for (const d of data.open) {
                lines.push(`- [ ] \`[${d.type}]\` **${d.task}**`);
                lines.push(`  > ${d.at}：${d.error}`);
            }
        } else {
            lines.push("- 暂无已知缺陷 🎉");
        }

        lines.push("", "## ✅ 近期修复");
        if (data.resolved.length > 0) {
            for (const d of data.resolved.slice(0, 5)) {
                lines.push(`- [x] **${d.task}** — ${d.resolvedNote}（${d.resolvedAt}）`);
            }
        } else {
            lines.push("- 暂无修复记录");
        }

        lines.push("", "## 🛡️ 审批审计");
        if (approvals.length > 0) {
            for (const a of approvals) {
                const action = a.actionType ?? "unknown_action";
                const risk = a.risk ?? "unknown";
                const decision = a.decision ?? "unknown";
                const when = a.resolvedAt ?? a.createdAt ?? "";
                const reason = a.reason ? `，原因：${String(a.reason).slice(0, 60)}` : "";
                lines.push(`- [${risk}] ${action} → ${decision}（${when}）${reason}`);
            }
        } else {
            lines.push("- 暂无审批记录");
        }

        lines.push("", "---", `*自动生成 by WuXing-Agent · ${snap.timestamp}*`);

        writeFileSync(STATUS_FILE, lines.join("\n"), "utf-8");
    }
}

// 单例导出
export const statusBoard = new StatusBoard();
