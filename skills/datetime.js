// skills/datetime.js
// 技能：获取当前系统时间
// 格式选项：full / date / time / iso
export async function handler({ format = "full", timezone } = {}) {
    const opts = timezone ? { timeZone: timezone } : {};

    const now = new Date();

    switch (format) {
        case "date":
            return now.toLocaleDateString("zh-CN", opts);
        case "time":
            return now.toLocaleTimeString("zh-CN", opts);
        case "iso":
            return now.toISOString();
        default:
            return now.toLocaleString("zh-CN", opts);
    }
}
