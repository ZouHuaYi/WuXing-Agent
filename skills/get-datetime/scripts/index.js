// skills/get-datetime/scripts/index.js
export async function handler({ format = "full", timezone } = {}) {
    const opts = timezone ? { timeZone: timezone } : {};

    const now = new Date();

    switch (format) {
        case "date":
            return now.toLocaleDateString("zh-CN", { ...opts, year: "numeric", month: "2-digit", day: "2-digit" });
        case "time":
            return now.toLocaleTimeString("zh-CN", { ...opts, hour: "2-digit", minute: "2-digit", second: "2-digit" });
        case "iso":
            return now.toISOString();
        default: {
            const date = now.toLocaleDateString("zh-CN", { ...opts, year: "numeric", month: "2-digit", day: "2-digit" });
            const time = now.toLocaleTimeString("zh-CN", { ...opts, hour: "2-digit", minute: "2-digit", second: "2-digit" });
            const weekdays = ["日", "一", "二", "三", "四", "五", "六"];
            const wd = weekdays[now.getDay()];
            return `${date} 星期${wd} ${time}`;
        }
    }
}
