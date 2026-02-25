// src/utils/logger.js
// 进化事件日志：同步输出到控制台 + 追加写入 logs/evolution.log
import { appendFile, mkdir } from "fs/promises";
import { existsSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../");

// 五行事件类型
export const EV = {
    WATER:      "水-感知",
    FIRE:       "火-直觉",
    EARTH:      "土-逻辑",
    METAL:      "金-反思",
    WOOD:       "木-生长",
    DREAM:      "梦境-折叠",
    ENTROPY:    "熵减-修剪",
    VISION:     "水-视觉",
    SYSTEM:     "系统",
};

function timestamp() {
    return new Date().toISOString().replace("T", " ").slice(0, 19);
}

function format(level, event, message) {
    return `[${timestamp()}] [${level.padEnd(6)}] [${event}] ${message}`;
}

class EvolutionLogger {
    constructor() {
        this.logPath = null;
        this.ready = false;
    }

    async init(logFile = "logs/evolution.log") {
        this.logPath = join(ROOT, logFile);
        const dir = dirname(this.logPath);
        if (!existsSync(dir)) {
            await mkdir(dir, { recursive: true });
        }
        // 写入会话分隔线
        await this._write(`\n${"─".repeat(60)}\n[${timestamp()}] SESSION START\n${"─".repeat(60)}\n`);
        this.ready = true;
    }

    info(event, message) {
        const line = format("INFO", event, message);
        console.log(`[${event}] ${message}`);
        this._write(line + "\n");
    }

    warn(event, message) {
        const line = format("WARN", event, message);
        console.warn(`[${event}] ${message}`);
        this._write(line + "\n");
    }

    evolution(event, message) {
        const line = format("EVOL", event, message);
        // 进化事件用特殊格式高亮
        console.log(`\n  *** ${line} ***\n`);
        this._write(line + "\n");
    }

    async _write(content) {
        if (!this.logPath) return;
        try {
            await appendFile(this.logPath, content, "utf-8");
        } catch {
            // 日志写入失败不阻断主流程
        }
    }
}

// 单例：整个进程共享同一个 logger
export const logger = new EvolutionLogger();
