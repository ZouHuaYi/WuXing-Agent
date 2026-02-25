// skills/system_info.js
// 技能：获取当前运行环境信息
import os from "os";

export async function handler({ detail = "all" } = {}) {
    const mem  = process.memoryUsage();
    const toMB = (n) => (n / 1024 / 1024).toFixed(1) + " MB";

    const info = {
        platform: {
            os:      `${process.platform} (${os.release()})`,
            arch:    process.arch,
            node:    process.version,
            cpus:    os.cpus().length,
        },
        memory: {
            rss:       toMB(mem.rss),
            heapUsed:  toMB(mem.heapUsed),
            heapTotal: toMB(mem.heapTotal),
            freeMem:   toMB(os.freemem()),
            totalMem:  toMB(os.totalmem()),
        },
        uptime: {
            process: `${(process.uptime() / 60).toFixed(1)} 分钟`,
            system:  `${(os.uptime()      / 3600).toFixed(1)} 小时`,
        },
    };

    if (detail === "memory")   return JSON.stringify(info.memory,   null, 2);
    if (detail === "platform") return JSON.stringify(info.platform,  null, 2);
    if (detail === "uptime")   return JSON.stringify(info.uptime,    null, 2);

    return JSON.stringify(info, null, 2);
}
