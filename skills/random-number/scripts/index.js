// skills/random-number/scripts/index.js
export async function handler({ min = 1, max = 100 } = {}) {
    const lo = Math.ceil(min);
    const hi = Math.floor(max);
    if (lo > hi) return `【参数错误】min（${min}）不能大于 max（${max}）`;
    const n = Math.floor(Math.random() * (hi - lo + 1)) + lo;
    return `随机数（${lo}~${hi}）：${n}`;
}
