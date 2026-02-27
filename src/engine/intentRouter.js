import { existsSync, readFileSync } from "fs";
import { resolve } from "path";

const DEFECTS_FILE = resolve(process.cwd(), "data/defects.json");

const PATTERNS = {
    query: /你好|hi|hello|在吗|你是谁|你是什么模型|what model|who are you|介绍一下|能做什么/i,
    observe: /状态|status|列出|list|目录|文件|workspace|读取|read|查看|show|总结.*status/i,
    simpleOps: /修改|改一行|重命名|rename|创建文件|写入配置|replace|patch|修个小问题|小改/i,
    expert: /重构|架构|debug|调试|修复复杂|实现|开发|写代码|算法|性能|并发|数据库|agent|mcp|编排/i,
};

function pickTier(input) {
    const text = String(input || "").trim();
    if (!text) return "L1_QUERY";
    if (PATTERNS.query.test(text)) return "L1_QUERY";
    if (PATTERNS.observe.test(text)) return "L2_OBSERVE";
    if (PATTERNS.simpleOps.test(text)) return "L3_SIMPLE_OPS";
    if (PATTERNS.expert.test(text) || text.length > 100) return "L4_EXPERT";
    return "L2_OBSERVE";
}

function getRecentFailures(limit = 3) {
    try {
        if (!existsSync(DEFECTS_FILE)) return [];
        const parsed = JSON.parse(readFileSync(DEFECTS_FILE, "utf-8"));
        const open = Array.isArray(parsed?.open) ? parsed.open : [];
        return open.slice(-limit).map((d) => ({
            task: String(d.task || "").slice(0, 120),
            error: String(d.error || "").slice(0, 160),
            type: d.type || "UNKNOWN",
        }));
    } catch {
        return [];
    }
}

function buildPlan(tier, input) {
    if (tier === "L1_QUERY") {
        return [{ step: "直接回复用户问题，不调用工具", requiresExpert: false }];
    }
    if (tier === "L2_OBSERVE") {
        return [
            { step: "优先读取本地状态与工作区信息", requiresExpert: false },
            { step: "给出简明结论", requiresExpert: false },
        ];
    }
    if (tier === "L3_SIMPLE_OPS") {
        return [
            { step: "先确认目标文件/配置位置", requiresExpert: false },
            { step: "执行小范围修改并校验", requiresExpert: false },
            { step: "输出变更与结果", requiresExpert: false },
        ];
    }
    return [
        { step: "先拆解任务并输出 Task Plan(JSON)", requiresExpert: false },
        { step: "优先本地工具执行可完成子任务", requiresExpert: false },
        { step: "仅在复杂编码/调试时调用外部专家", requiresExpert: true },
        { step: "汇总结果与风险", requiresExpert: false },
    ];
}

function assessCapabilityFit(userInput, selfProfile = {}) {
    const text = String(userInput || "").toLowerCase();
    const availableTools = new Set([
        ...(selfProfile?.capabilities?.builtinTools ?? []),
        ...(selfProfile?.capabilities?.dynamicTools ?? []),
        ...(selfProfile?.capabilities?.mcpTools ?? []),
    ].map((x) => String(x || "").toLowerCase()));

    const gaps = [];
    let fit = "high";

    const asksBrowser = /浏览器|browser|playwright|网页自动化|点击页面/i.test(text);
    if (asksBrowser) {
        const ok = [...availableTools].some((name) => name.includes("playwright"));
        if (!ok) {
            gaps.push("未检测到可用的浏览器自动化工具（playwright）");
            fit = "medium";
        }
    }

    const asksMcp = /mcp|外部服务|context7|figma/i.test(text);
    if (asksMcp && (selfProfile?.capabilities?.mcpTools?.length ?? 0) === 0) {
        gaps.push("当前未挂载任何 MCP 工具");
        fit = "medium";
    }

    const asksWrite = /修改|重写|实现|开发|写代码|重构/i.test(text);
    if (asksWrite && (selfProfile?.limits?.readOnlyMode === true)) {
        gaps.push("当前处于只读限制，无法执行写操作");
        fit = "low";
    }

    return { fit, gaps };
}

export function routeIntent(userInput, selfProfile = {}) {
    const tier = pickTier(userInput);
    const plan = buildPlan(tier, userInput);
    const capability = assessCapabilityFit(userInput, selfProfile);
    const anchors = {
        cwd: process.cwd(),
        recentFailures: getRecentFailures(3),
        selfProfileSummary: {
            localTools: (selfProfile?.capabilities?.builtinTools?.length ?? 0) +
                (selfProfile?.capabilities?.dynamicTools?.length ?? 0),
            mcpTools: selfProfile?.capabilities?.mcpTools?.length ?? 0,
            workflowCount: selfProfile?.workflows?.length ?? 0,
            hardLimits: selfProfile?.limits ?? {},
        },
    };

    const requiresPlanning = tier === "L3_SIMPLE_OPS" || tier === "L4_EXPERT";
    const canSkipExpert = tier !== "L4_EXPERT" || capability.fit === "low";
    const decision = canSkipExpert ? "LOCAL_FIRST" : "EXPERT_GATED";

    return {
        tier,
        decision,
        requiresPlanning,
        canSkipExpert,
        plan,
        capabilityFit: capability.fit,
        capabilityGaps: capability.gaps,
        anchors,
        selfProfile,
        inputPreview: String(userInput || "").slice(0, 140),
    };
}

export function buildDirectReply(userInput, route, statusSummary = "") {
    const text = String(userInput || "").trim();
    if (/你是什么模型|what model/i.test(text)) {
        return "我是 WuXing-Agent 你的最好AI助手。";
    }
    if (/状态|status/i.test(text) && statusSummary) {
        return `系统状态摘要：\n${statusSummary}`;
    }
    if (route.tier === "L1_QUERY") {
        return "已收到。这个问题不需要调用专家工具，我会直接回答并保持轻量执行。";
    }
    return "";
}
