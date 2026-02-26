// 五行元数据 — 前端渲染用
export const ELEMENTS = {
  water:  { label: "水·感知",  color: "#38bdf8", bg: "rgba(56,189,248,0.08)",  icon: "💧", border: "#1e40af" },
  fire:   { label: "火·执行",  color: "#f97316", bg: "rgba(249,115,22,0.08)",  icon: "🔥", border: "#9a3412" },
  earth:  { label: "土·推理",  color: "#eab308", bg: "rgba(234,179,8,0.08)",   icon: "⚖️", border: "#854d0e" },
  metal:  { label: "金·反思",  color: "#a8a29e", bg: "rgba(168,162,158,0.08)", icon: "⚔️", border: "#57534e" },
  wood:   { label: "木·记忆",  color: "#4ade80", bg: "rgba(74,222,128,0.08)",  icon: "🌿", border: "#166534" },
  tool:   { label: "工具",      color: "#c084fc", bg: "rgba(192,132,252,0.08)", icon: "🔧", border: "#7e22ce" },
  system: { label: "系统",      color: "#818cf8", bg: "rgba(129,140,248,0.08)", icon: "⚙️", border: "#3730a3" },
  answer: { label: "完成",      color: "#34d399", bg: "rgba(52,211,153,0.08)",  icon: "✨", border: "#065f46" },
};

export function getElement(key) {
  return ELEMENTS[key] ?? ELEMENTS.system;
}
