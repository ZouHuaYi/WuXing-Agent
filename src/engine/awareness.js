// src/engine/awareness.js
// 【水-感知】：实时环境快照
//
// 纯同步函数，无外部依赖，无 LLM 调用。
// 用途：每次推理前生成当前环境状态，注入系统提示。
import os from "os";

/**
 * 生成当前运行环境的结构化快照
 * @returns {{ timestamp, date, platform, arch, freeMemMB, cpuLoad1m, nodeVersion }}
 */
export function getSnapshot() {
    const now = new Date();
    return {
        timestamp:   now.toLocaleString("zh-CN"),
        date:        now.toISOString().slice(0, 10),           // YYYY-MM-DD
        weekday:     now.toLocaleDateString("zh-CN", { weekday: "long" }),
        platform:    process.platform,
        arch:        os.arch(),
        freeMemMB:   Math.round(os.freemem() / 1024 / 1024),
        totalMemMB:  Math.round(os.totalmem() / 1024 / 1024),
        cpuLoad1m:   (os.loadavg()[0] ?? 0).toFixed(2),       // 1 分钟平均负载
        nodeVersion: process.version,
        cwd:         process.cwd(),
    };
}

/**
 * 返回适合注入 System Prompt 的单行摘要
 * 格式：2026-02-26 星期四 | Windows x64 | 内存 6144/16384 MB | Node v22
 */
export function getSnapshotLine() {
    const s = getSnapshot();
    const memUsed = s.totalMemMB - s.freeMemMB;
    return (
        `${s.date} ${s.weekday} | ` +
        `${s.platform} ${s.arch} | ` +
        `内存 ${memUsed}/${s.totalMemMB} MB | ` +
        `Node ${s.nodeVersion}`
    );
}
