// src/engine/goalTracker.js
// 【神-意志】：长期目标追踪器
//
// "神"是五行之上的第六维——超越单次会话的持续意志方向。
// 每次启动时，Agent 不再被动等待指令，而是主动检查自己的长线任务进度。
//
// 数据结构：data/goals.json
// 指令接口：
//   goalTracker.add(title, description, deadline)
//   goalTracker.list()
//   goalTracker.advance(id, note, delta)   → 更新进度
//   goalTracker.complete(id)
//   goalTracker.briefing()                 → 生成今日晨报（LLM 辅助）
//   goalTracker.checkTaskRelevance(task)   → 判断一个任务是否推进了某个目标
//
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { dirname, resolve, join } from "path";
import { ChatOpenAI } from "@langchain/openai";
import { SystemMessage, HumanMessage } from "@langchain/core/messages";
import cfg from "../../config/wuxing.json" with { type: "json" };
import { logger, EV } from "../utils/logger.js";

const GOALS_FILE = resolve(process.cwd(), "data/goals.json");
const llm = new ChatOpenAI({ modelName: cfg.models.reasoning, temperature: 0.3 });

// ── 数据模型 ──────────────────────────────────────────────
//
// Goal {
//   id:          string  (goal_xxxxxxxx)
//   title:       string
//   description: string
//   deadline:    string  (YYYY-MM-DD，可选)
//   priority:    "high" | "medium" | "low"
//   status:      "active" | "paused" | "completed" | "abandoned"
//   progress:    number  (0-100)
//   milestones:  Milestone[]
//   log:         LogEntry[]   (自动追加)
//   createdAt:   string  (ISO)
//   updatedAt:   string  (ISO)
// }
//
// Milestone { id, title, done: boolean }
// LogEntry  { at, note, delta }       delta = 进度变化量

function newId() {
    return "goal_" + Math.random().toString(36).slice(2, 10);
}

function now() {
    return new Date().toISOString();
}

// ── 核心类 ────────────────────────────────────────────────

export class GoalTracker {
    constructor() {
        this._ensureDir();
        this.goals = this._load();
    }

    _ensureDir() {
        const dir = dirname(GOALS_FILE);
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    }

    _load() {
        if (!existsSync(GOALS_FILE)) return [];
        try {
            const raw = readFileSync(GOALS_FILE, "utf-8");
            return JSON.parse(raw) ?? [];
        } catch {
            return [];
        }
    }

    _save() {
        writeFileSync(GOALS_FILE, JSON.stringify(this.goals, null, 2), "utf-8");
    }

    // ── CRUD ─────────────────────────────────────────────

    add({ title, description = "", deadline = null, priority = "medium", milestones = [] }) {
        const goal = {
            id:          newId(),
            title,
            description,
            deadline,
            priority,
            status:      "active",
            progress:    0,
            milestones:  milestones.map((t, i) => ({ id: `ms_${i}`, title: t, done: false })),
            log:         [],
            createdAt:   now(),
            updatedAt:   now(),
        };
        this.goals.push(goal);
        this._save();
        logger.info(EV.SYSTEM, `[神-意志] 新目标种下：${title}`);
        return goal;
    }

    get(id) {
        return this.goals.find((g) => g.id === id);
    }

    list(statusFilter = null) {
        return statusFilter
            ? this.goals.filter((g) => g.status === statusFilter)
            : this.goals;
    }

    // 推进进度（delta 为增量，note 为本次进展说明）
    advance(id, note, delta = 5) {
        const goal = this.get(id);
        if (!goal) return null;

        goal.progress   = Math.min(100, goal.progress + delta);
        goal.updatedAt  = now();
        goal.log.push({ at: now(), note, delta });

        if (goal.progress >= 100) {
            goal.status = "completed";
            logger.evolution(EV.SYSTEM, `[神-意志] 目标达成：${goal.title}`);
        }

        this._save();
        return goal;
    }

    // 勾选里程碑
    checkMilestone(goalId, milestoneId) {
        const goal = this.get(goalId);
        if (!goal) return;
        const ms = goal.milestones.find((m) => m.id === milestoneId);
        if (!ms || ms.done) return;
        ms.done = true;
        // 每个里程碑完成自动加进度
        const msTotal = goal.milestones.length;
        const delta   = msTotal > 0 ? Math.floor(100 / msTotal) : 10;
        this.advance(goalId, `里程碑完成：${ms.title}`, delta);
    }

    complete(id, note = "手动标记完成") {
        const goal = this.get(id);
        if (!goal) return;
        goal.status   = "completed";
        goal.progress = 100;
        goal.updatedAt = now();
        goal.log.push({ at: now(), note, delta: 100 - goal.progress });
        this._save();
    }

    pause(id)   { this._setStatus(id, "paused"); }
    abandon(id) { this._setStatus(id, "abandoned"); }

    _setStatus(id, status) {
        const goal = this.get(id);
        if (!goal) return;
        goal.status    = status;
        goal.updatedAt = now();
        this._save();
    }

    // ── 愿景拆解器：自然语言 → 结构化目标 + 里程碑 ──────────
    // 输入：自由描述的长期目标文本
    // 输出：已写入 goals.json 的 Goal 对象
    async decompose(visionText) {
        const DECOMPOSE_PROMPT = `
你是一个目标规划专家。将以下自然语言愿景拆解为结构化的长期目标计划。

要求：
1. 提炼一个清晰的目标标题（≤30字）
2. 生成 3-7 个可执行的里程碑，每个里程碑是一个具体可验证的任务
3. 根据描述估算合理截止日期（格式 YYYY-MM-DD）
4. 判断优先级（high / medium / low）

输出格式（严格 JSON，不含 markdown）：
{
  "title": "目标标题",
  "description": "目标描述（≤100字）",
  "deadline": "YYYY-MM-DD",
  "priority": "high",
  "milestones": [
    "里程碑1（具体可执行）",
    "里程碑2",
    "里程碑3"
  ],
  "todayTask": "今天可以立即着手的第一步（一句话）"
}
`.trim();

        const res = await llm.invoke([
            new SystemMessage(DECOMPOSE_PROMPT),
            new HumanMessage(`愿景描述：${visionText}`),
        ]);

        let def;
        try {
            def = JSON.parse(res.content.trim());
        } catch {
            // 容错：LLM 输出带了 markdown 围栏
            const cleaned = res.content.trim()
                .replace(/^```json?\n?/i, "")
                .replace(/\n?```$/, "")
                .trim();
            def = JSON.parse(cleaned);
        }

        const goal = this.add({
            title:       def.title,
            description: def.description ?? visionText.slice(0, 100),
            deadline:    def.deadline ?? null,
            priority:    def.priority ?? "medium",
            milestones:  def.milestones ?? [],
        });

        // 将 todayTask 写入第一条日志
        if (def.todayTask) {
            goal.log.push({ at: now(), note: `今日第一步：${def.todayTask}`, delta: 0 });
            this._save();
        }

        return { goal, todayTask: def.todayTask ?? null };
    }

    // ── 判断一次任务是否推进了某个活跃目标（用于自动更新进度）───
    // 返回最相关的 goal，如无则返回 null
    async checkTaskRelevance(taskSummary) {
        const active = this.list("active");
        if (active.length === 0) return null;

        const goalList = active
            .map((g) => `- [${g.id}] ${g.title}（当前 ${g.progress}%）：${g.description.slice(0, 80)}`)
            .join("\n");

        try {
            const res = await llm.invoke([
                new SystemMessage(
                    "你是目标追踪助手。判断以下已完成任务是否推进了下列长期目标之一。\n" +
                    "如果是，输出 JSON：{\"goalId\": \"goal_xxx\", \"delta\": 5, \"note\": \"说明\"}\n" +
                    "如果无关，输出 JSON：{\"goalId\": null}\n" +
                    "delta 为进度增量（1-20），根据贡献度估算。不要输出任何其他内容。"
                ),
                new HumanMessage(
                    `已完成任务：${taskSummary.slice(0, 400)}\n\n活跃目标：\n${goalList}`
                ),
            ]);

            const parsed = JSON.parse(res.content.trim());
            if (parsed.goalId) {
                this.advance(parsed.goalId, parsed.note ?? taskSummary.slice(0, 60), parsed.delta ?? 5);
                return this.get(parsed.goalId);
            }
        } catch { /* 静默，不影响主流程 */ }

        return null;
    }

    // ── 今日晨报（LLM 生成）──────────────────────────────
    // 返回一段给 Agent 的"今日使命提示"，注入推理层系统提示
    async briefing() {
        const active = this.list("active");
        if (active.length === 0) {
            return null; // 没有活跃目标，不注入
        }

        // 优先显示高优先级 + 接近截止日期的目标
        const sorted = [...active].sort((a, b) => {
            const priorityScore = { high: 3, medium: 2, low: 1 };
            return (priorityScore[b.priority] ?? 1) - (priorityScore[a.priority] ?? 1);
        });

        const topGoals = sorted.slice(0, 3); // 最多展示 3 个

        // 构建简洁的目标摘要（直接用于系统提示，不调用 LLM 避免启动时慢）
        const today = new Date().toLocaleDateString("zh-CN");
        const lines = [
            `【今日使命 ${today}】`,
            ...topGoals.map((g) => {
                const remaining = g.deadline
                    ? `（截止 ${g.deadline}）`
                    : "";
                const bar = "▓".repeat(Math.floor(g.progress / 10)) +
                            "░".repeat(10 - Math.floor(g.progress / 10));
                return `  [${g.priority.toUpperCase()}] ${g.title} ${remaining}\n  进度：${bar} ${g.progress}%`;
            }),
            `当你完成的任务与以上目标相关时，会自动更新进度。`,
        ];

        return lines.join("\n");
    }

    // ── 格式化展示（用于 :goal 指令）──────────────────────
    format(filterStatus = null) {
        const list = filterStatus ? this.list(filterStatus) : this.goals;
        if (list.length === 0) {
            return filterStatus
                ? `当前没有 [${filterStatus}] 状态的目标。`
                : "目标库为空。用 :goal add <标题> 开始规划第一个长期目标。";
        }

        const STATUS_ICON = { active: "🔥", paused: "⏸️", completed: "✅", abandoned: "❌" };
        const PRIORITY_LABEL = { high: "[高]", medium: "[中]", low: "[低]" };

        return list.map((g) => {
            const icon     = STATUS_ICON[g.status] ?? "○";
            const priority = PRIORITY_LABEL[g.priority] ?? "";
            const deadline = g.deadline ? ` 截止 ${g.deadline}` : "";
            const bar      = "▓".repeat(Math.floor(g.progress / 10)) +
                             "░".repeat(10 - Math.floor(g.progress / 10));
            const lastLog  = g.log.length > 0
                ? `\n    最近：${g.log[g.log.length - 1].note.slice(0, 50)}`
                : "";

            const msDone = g.milestones.filter((m) => m.done).length;
            const msInfo = g.milestones.length > 0
                ? `  里程碑：${msDone}/${g.milestones.length}`
                : "";

            return [
                `${icon} ${priority} ${g.title}${deadline}`,
                `   ID：${g.id}  进度：${bar} ${g.progress}%${msInfo}`,
                `   ${g.description.slice(0, 80)}${lastLog}`,
            ].join("\n");
        }).join("\n\n");
    }
}

// 单例导出
export const goalTracker = new GoalTracker();
