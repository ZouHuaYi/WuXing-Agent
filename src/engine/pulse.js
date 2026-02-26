// src/engine/pulse.js
// 【木-震】：五行心跳调度器
//
// 让 Agent 从"被动响应"转为"主动代谢"。
// 每个心跳周期，系统自主扫描：
//   1. STATUS.md 中的待修复缺陷（优先级最高）
//   2. goalTracker 中待推进的里程碑
//   3. 若无上述，随机选择一次"自我完善"任务
// 然后通过 LangGraph 驱动执行，结果写入记忆和 STATUS.md。
//
// 安全约束（金之边界）：
//   - 每次心跳最多执行 maxTasksPerBeat 个任务（防失控）
//   - 自主任务不会出现在对话历史中（不污染 sessionMessages）
//   - 出现连续失败时自动降低心跳频率（指数退避）
//
import { HumanMessage } from "@langchain/core/messages";
import { goalTracker }  from "./goalTracker.js";
import { statusBoard }  from "./statusBoard.js";
import { logger, EV }  from "../utils/logger.js";
import { readFileSync, existsSync } from "fs";
import { resolve } from "path";
import cfg from "../../config/wuxing.json" with { type: "json" };

const DEFECTS_FILE = resolve(process.cwd(), "data/defects.json");

// 读取开放缺陷列表
function loadOpenDefects() {
    if (!existsSync(DEFECTS_FILE)) return [];
    try {
        const data = JSON.parse(readFileSync(DEFECTS_FILE, "utf-8"));
        return data.open ?? [];
    } catch {
        return [];
    }
}

// 生成本次心跳的自主任务指令
function buildProactiveTask() {
    const defects = loadOpenDefects();
    const active  = goalTracker.list("active");

    // 优先级 1：修复已知缺陷
    if (defects.length > 0) {
        const d = defects[0];
        return {
            type:    "defect_fix",
            task:    `【自主修复】上次执行「${d.task}」时出现错误（${d.error.slice(0, 80)}）。` +
                     `请重新分析原因并尝试修复，修复成功后使用 STATUS.md 中记录的修复方案。`,
            context: d,
        };
    }

    // 优先级 2：推进里程碑
    for (const goal of active) {
        const pending = goal.milestones.filter((m) => !m.done);
        if (pending.length > 0) {
            return {
                type:    "milestone",
                task:    `【自主推进】长期目标「${goal.title}」的下一个里程碑：「${pending[0].title}」。` +
                         `请规划并尽可能地推进完成这个里程碑，记录进度。`,
                context: { goalId: goal.id, milestoneId: pending[0].id },
            };
        }
    }

    // 优先级 3：能力自检
    return {
        type: "self_check",
        task: "【自主自检】检查 workspace/ 目录中是否有未完成的代码任务，" +
              "以及 skills/ 中是否有 Stub 技能需要实现。列出发现的问题并记录到 STATUS.md。",
        context: null,
    };
}

// ── 核心类 ────────────────────────────────────────────────

export class WuXingPulse {
    /**
     * @param {Function} runGraph  app.invoke 的封装，接收 {messages}，返回 result
     * @param {Object}   options
     * @param {number}   options.intervalMs       心跳间隔（默认 1 小时）
     * @param {number}   options.maxTasksPerBeat  每次心跳最多执行几个任务（默认 1）
     */
    constructor(runGraph, options = {}) {
        this.runGraph       = runGraph;
        this.intervalMs     = options.intervalMs    ?? cfg.pulse?.intervalMs    ?? 3_600_000;
        this.maxTasks       = options.maxTasksPerBeat ?? cfg.pulse?.maxTasksPerBeat ?? 1;
        this._timer         = null;
        this._running       = false;
        this._consecutiveFails = 0;
        this._beatCount     = 0;
    }

    get isRunning() { return this._timer !== null; }

    start() {
        if (this._timer) return;
        logger.info(EV.SYSTEM, `[木-震] 五行心跳已激活，间隔 ${this.intervalMs / 60000} 分钟`);
        console.log(`\n[木-震] 五行心跳已激活（每 ${this.intervalMs / 60000} 分钟自主代谢一次）`);

        // 立即跳动一次（5 秒后，等系统初始化完成）
        setTimeout(() => this._beat(), 5_000);

        this._timer = setInterval(() => this._beat(), this.intervalMs);
    }

    stop() {
        if (!this._timer) return;
        clearInterval(this._timer);
        this._timer = null;
        logger.info(EV.SYSTEM, "[木-震] 五行心跳已停止");
        console.log("\n[木-震] 五行心跳已停止");
    }

    status() {
        return {
            running:   this.isRunning,
            interval:  this.intervalMs,
            beats:     this._beatCount,
            fails:     this._consecutiveFails,
        };
    }

    // ── 单次心跳 ─────────────────────────────────────────

    async _beat() {
        if (this._running) {
            logger.info(EV.SYSTEM, "[木-震] 上一次心跳尚未结束，跳过本次");
            return;
        }
        this._running = true;
        this._beatCount++;

        const { task, type, context } = buildProactiveTask();
        logger.info(EV.SYSTEM, `[木-震] 心跳 #${this._beatCount}：${type} — ${task.slice(0, 60)}`);
        console.log(`\n[木-震] 心跳 #${this._beatCount}（${type}）`);
        console.log(`  → ${task.slice(0, 80)}...`);

        try {
            const maxCycles = cfg.tools?.maxCycles ?? 12;
            const result    = await this.runGraph(
                { messages: [new HumanMessage(task)] },
                { recursionLimit: maxCycles * 2 + 10 }
            );

            const answer = result.foundWisdom
                ?? result.messages?.[result.messages.length - 1]?.content
                ?? "(无输出)";

            logger.evolution(EV.SYSTEM, `[木-震] 心跳完成：${answer.slice(0, 100)}`);
            console.log(`[木-震] 心跳完成 ✓`);

            // 里程碑任务完成后尝试更新进度
            if (type === "milestone" && context?.goalId) {
                goalTracker.advance(context.goalId, `心跳推进：${answer.slice(0, 60)}`, 8);
            }

            this._consecutiveFails = 0;

        } catch (e) {
            this._consecutiveFails++;
            logger.warn(EV.SYSTEM, `[木-震] 心跳失败（连续 ${this._consecutiveFails} 次）：${e.message}`);
            console.log(`[木-震] 心跳失败：${e.message.slice(0, 80)}`);

            // 指数退避：连续失败时拉长间隔（最多 8 倍）
            if (this._consecutiveFails >= 3 && this._timer) {
                const backoff = Math.min(this.intervalMs * Math.pow(2, this._consecutiveFails - 2), this.intervalMs * 8);
                console.log(`[木-震] 连续失败，退避至 ${backoff / 60000} 分钟后再跳`);
                this.stop();
                setTimeout(() => this.start(), backoff);
            }
        } finally {
            this._running = false;
        }
    }
}
