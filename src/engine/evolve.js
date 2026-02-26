// src/engine/evolve.js
// 【木克土】：基因重组器（架构自进化）
//
// Agent 可以阅读并在 workspace/ 提案，但不能自动应用核心架构变更。
// 变更流程：
//   1. Agent 读 src/engine/wuxingGraph.js（已有 read_file 工具）
//   2. Agent 在 workspace/proposed_graph.js 写出修改方案
//   3. Agent 告知用户运行 :evolve apply
//   4. GeneticEvolver 备份 → 语法检查 → 写盘
//   5. 用户手动重启（exit → npm run start）
//
// 安全三原则（金之铁律）：
//   1. 备份先行   — 修改前生成时间戳备份
//   2. 语法门禁   — node --check 通过才写盘
//   3. 人类确认   — apply 只能由 REPL :evolve apply 触发，Agent 无权自调
//
import {
    copyFileSync, existsSync, mkdirSync,
    readFileSync, writeFileSync, readdirSync, statSync, unlinkSync
} from "fs";
import { execFileSync } from "child_process";
import { resolve, join } from "path";
import { logger, EV } from "../utils/logger.js";

const CORE_GRAPH = resolve(process.cwd(), "src/engine/wuxingGraph.js");
const PROPOSAL   = resolve(process.cwd(), "workspace/proposed_graph.js");
const BACKUP_DIR = resolve(process.cwd(), "data/backups");

// 受保护文件：禁止通过此工具修改
const PROTECTED = new Set([
    "src/engine/evolve.js",
    "src/engine/toolBox.js",
    "config/wuxing.json",
    ".env",
]);

function tsTag() {
    return new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
}

export class GeneticEvolver {

    // ── 备份当前核心图 ────────────────────────────────────
    backup(label = "manual") {
        if (!existsSync(BACKUP_DIR)) mkdirSync(BACKUP_DIR, { recursive: true });
        const dest = join(BACKUP_DIR, `wuxingGraph_${label}_${tsTag()}.js`);
        copyFileSync(CORE_GRAPH, dest);
        logger.info(EV.METAL, `[金-备份] 核心图已备份：${dest}`);
        return dest;
    }

    // ── 查看 workspace 中的提案 ───────────────────────────
    reviewProposal() {
        if (!existsSync(PROPOSAL)) {
            return {
                exists:  false,
                message: "workspace/proposed_graph.js 不存在。\n" +
                         "请让 Agent 读取 src/engine/wuxingGraph.js，\n" +
                         "在 workspace/proposed_graph.js 写出修改方案后再运行 :evolve apply",
            };
        }
        const code  = readFileSync(PROPOSAL, "utf-8");
        const lines = code.split("\n").length;
        return {
            exists:  true,
            lines,
            preview: code.split("\n").slice(0, 20).join("\n"),
            message: `workspace/proposed_graph.js 已就绪（${lines} 行）\n运行 :evolve apply 应用`,
        };
    }

    // ── 应用提案（含完整安全门禁）────────────────────────
    apply(targetFile = CORE_GRAPH) {
        // 受保护文件检查
        const relPath = targetFile
            .replace(resolve(process.cwd()), "")
            .replace(/\\/g, "/")
            .replace(/^\//, "");

        if (PROTECTED.has(relPath)) {
            return { success: false, message: `[金-拒绝] ${relPath} 受保护，不允许通过此工具修改。` };
        }

        if (!existsSync(PROPOSAL)) {
            return { success: false, message: "提案文件不存在：workspace/proposed_graph.js" };
        }

        const newCode = readFileSync(PROPOSAL, "utf-8");

        // 语法门禁：写入临时文件后 node --check
        const tmpFile = join(BACKUP_DIR, `__syntax_${Date.now()}.js`);
        if (!existsSync(BACKUP_DIR)) mkdirSync(BACKUP_DIR, { recursive: true });
        writeFileSync(tmpFile, newCode, "utf-8");

        try {
            execFileSync(process.execPath, ["--check", tmpFile], {
                timeout: 10_000,
                stdio:   "pipe",
            });
        } catch (e) {
            try { unlinkSync(tmpFile); } catch { /* 静默 */ }
            const errMsg = (e.stderr ?? e.stdout ?? Buffer.from("")).toString().slice(0, 300);
            return {
                success: false,
                message: `[金-拒绝] 语法检查未通过，已阻止写盘。\n${errMsg}`,
            };
        }
        try { unlinkSync(tmpFile); } catch { /* 静默 */ }

        // 语法通过 → 备份 → 写盘
        const backupPath = this.backup("pre_evolve");
        writeFileSync(targetFile, newCode, "utf-8");
        logger.evolution(EV.WOOD, `[木-进化] 架构已更新：${relPath}，备份：${backupPath}`);

        return {
            success:    true,
            backupPath,
            message:    `[木-进化] 基因重组成功！\n备份：${backupPath}\n请重启系统激活新架构（exit → npm run start）`,
        };
    }

    // ── 回滚到最新备份 ────────────────────────────────────
    rollback() {
        if (!existsSync(BACKUP_DIR)) {
            return { success: false, message: "备份目录不存在，无法回滚" };
        }

        const files = readdirSync(BACKUP_DIR)
            .filter((f) => f.startsWith("wuxingGraph_"))
            .map((f) => ({ name: f, mtime: statSync(join(BACKUP_DIR, f)).mtimeMs }))
            .sort((a, b) => b.mtime - a.mtime);

        if (files.length === 0) {
            return { success: false, message: "没有可用的备份文件" };
        }

        const latest = join(BACKUP_DIR, files[0].name);
        copyFileSync(latest, CORE_GRAPH);
        logger.info(EV.METAL, `[金-回滚] 已恢复：${files[0].name}`);
        return {
            success: true,
            message: `[金-回滚] 已恢复到 ${files[0].name}\n请重启系统（exit → npm run start）生效`,
        };
    }

    // ── 列出最近备份 ─────────────────────────────────────
    listBackups() {
        if (!existsSync(BACKUP_DIR)) return [];
        return readdirSync(BACKUP_DIR)
            .filter((f) => f.startsWith("wuxingGraph_"))
            .sort()
            .reverse()
            .slice(0, 10);
    }
}

export const geneticEvolver = new GeneticEvolver();
