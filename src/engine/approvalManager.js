import { appendFileSync, existsSync, mkdirSync } from "fs";
import { dirname, resolve } from "path";
import { agentBus } from "./eventBus.js";
import { statusBoard } from "./statusBoard.js";
import agentsCfg from "../../config/agents.json" with { type: "json" };

const AUDIT_FILE = resolve(process.cwd(), "data/audit/approvals.jsonl");

function nowIso() {
    return new Date().toISOString();
}

function ensureAuditDir() {
    const dir = dirname(AUDIT_FILE);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

class ApprovalManager {
    constructor() {
        this.pending = new Map();
        this.policy = this._buildPolicy();
    }

    _buildPolicy() {
        const defaults = {
            riskRules: {
                low: { autoApprove: true, timeoutMs: 30_000, allowModify: false },
                medium: { autoApprove: false, timeoutMs: 60_000, allowModify: true },
                high: { autoApprove: false, timeoutMs: 90_000, allowModify: true },
                critical: { autoApprove: false, timeoutMs: 180_000, allowModify: false },
            },
        };

        const fromConfig = agentsCfg.approvalPolicy ?? {};
        return {
            riskRules: {
                ...defaults.riskRules,
                ...(fromConfig.riskRules ?? {}),
                low: { ...defaults.riskRules.low, ...(fromConfig.riskRules?.low ?? {}) },
                medium: { ...defaults.riskRules.medium, ...(fromConfig.riskRules?.medium ?? {}) },
                high: { ...defaults.riskRules.high, ...(fromConfig.riskRules?.high ?? {}) },
                critical: { ...defaults.riskRules.critical, ...(fromConfig.riskRules?.critical ?? {}) },
            },
        };
    }

    getPolicy() {
        return this.policy;
    }

    getRiskRule(risk = "high") {
        return this.policy.riskRules[risk] ?? this.policy.riskRules.high;
    }

    shouldRequest(risk = "high") {
        return !this.getRiskRule(risk).autoApprove;
    }

    _audit(entry) {
        ensureAuditDir();
        appendFileSync(AUDIT_FILE, `${JSON.stringify(entry)}\n`, "utf-8");
        statusBoard.touch?.();
    }

    listPending() {
        return [...this.pending.values()].map((item) => ({
            id: item.id,
            actionType: item.actionType,
            risk: item.risk,
            command: item.command,
            message: item.message,
            createdAt: item.createdAt,
            timeoutMs: item.timeoutMs,
            allowModify: item.allowModify,
            metadata: item.metadata ?? {},
        }));
    }

    async requestApproval({
        actionType,
        risk = "high",
        command,
        message,
        timeoutMs = null,
        allowModify = null,
        metadata = {},
    }) {
        const rule = this.getRiskRule(risk);
        const effectiveTimeout = Number(timeoutMs || rule.timeoutMs || 60_000);
        const effectiveAllowModify = typeof allowModify === "boolean" ? allowModify : !!rule.allowModify;
        const id = `appr_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
        const createdAt = nowIso();
        const payload = {
            id, actionType, risk, command, message, createdAt,
            timeoutMs: effectiveTimeout,
            allowModify: effectiveAllowModify,
            metadata,
        };

        if (rule.autoApprove) {
            this._audit({ ...payload, event: "approval.auto_approved", decision: "approve", resolvedAt: nowIso() });
            return { approved: true, decision: "approve", command };
        }

        agentBus.push(
            "approval.requested",
            "metal",
            `审批请求：${actionType}（${risk}）`,
            payload
        );

        return new Promise((resolveApproval) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                const result = { approved: false, decision: "reject", reason: "审批超时自动拒绝", command };
                this._audit({ ...payload, event: "approval.timeout", ...result, resolvedAt: nowIso() });
                agentBus.push("approval.timeout", "metal", `审批超时：${actionType} 已拒绝`, { id, actionType, risk });
                resolveApproval(result);
            }, effectiveTimeout);

            this.pending.set(id, {
                ...payload,
                timer,
                resolveApproval,
            });
        });
    }

    resolveDecision(id, { decision, patchedCommand = "", reason = "" }) {
        const item = this.pending.get(id);
        if (!item) return { ok: false, error: "审批单不存在或已处理" };

        clearTimeout(item.timer);
        this.pending.delete(id);

        const normalized = decision === "modify" ? "modify" : decision === "approve" ? "approve" : "reject";
        const finalCommand = normalized === "modify" && item.allowModify && patchedCommand.trim()
            ? patchedCommand.trim()
            : item.command;

        const approved = normalized === "approve" || normalized === "modify";
        const result = {
            approved,
            decision: normalized,
            command: finalCommand,
            reason: reason || "",
        };

        this._audit({
            id: item.id,
            actionType: item.actionType,
            risk: item.risk,
            command: item.command,
            finalCommand,
            message: item.message,
            metadata: item.metadata ?? {},
            event: "approval.resolved",
            decision: normalized,
            approved,
            reason: reason || "",
            createdAt: item.createdAt,
            resolvedAt: nowIso(),
        });

        agentBus.push(
            "approval.resolved",
            "metal",
            `审批结果：${item.actionType} -> ${normalized}`,
            {
                id: item.id,
                actionType: item.actionType,
                risk: item.risk,
                decision: normalized,
                approved,
            }
        );

        item.resolveApproval(result);
        return { ok: true, result };
    }
}

export const approvalManager = new ApprovalManager();
