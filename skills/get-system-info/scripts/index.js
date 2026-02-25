// skills/get-system-info/scripts/index.js
import os from "os";
import process from "process";

export async function handler({ detail = "all" } = {}) {
    const mem     = process.memoryUsage();
    const toMB    = (b) => (b / 1024 / 1024).toFixed(1);
    const uptime  = process.uptime();
    const hours   = Math.floor(uptime / 3600);
    const minutes = Math.floor((uptime % 3600) / 60);
    const seconds = Math.floor(uptime % 60);

    const sections = {
        platform: [
            `操作系统：${os.type()} ${os.release()}`,
            `平台架构：${process.platform} / ${os.arch()}`,
            `Node.js：${process.version}`,
            `CPU 核数：${os.cpus().length}`,
        ].join("\n"),

        memory: [
            `堆内存：${toMB(mem.heapUsed)} MB / ${toMB(mem.heapTotal)} MB`,
            `RSS：${toMB(mem.rss)} MB`,
            `外部内存：${toMB(mem.external)} MB`,
            `系统总内存：${toMB(os.totalmem())} MB`,
            `系统空闲内存：${toMB(os.freemem())} MB`,
        ].join("\n"),

        uptime: `进程运行时长：${hours}h ${minutes}m ${seconds}s`,
    };

    if (detail === "memory")   return sections.memory;
    if (detail === "platform") return sections.platform;
    if (detail === "uptime")   return sections.uptime;

    return [
        "【平台信息】",   sections.platform,
        "\n【内存状态】", sections.memory,
        "\n【运行时长】", sections.uptime,
    ].join("\n");
}
