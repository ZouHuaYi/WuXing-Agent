import { EventEmitter } from "events";
import { spawn } from "child_process";
import { readFileSync, existsSync, mkdirSync } from "fs";
import { resolve } from "path";
import { agentBus } from "./eventBus.js";
import { approvalManager } from "./approvalManager.js";

const DEFAULT_TTL_MS = 10 * 60 * 1000;
const LOG_LIMIT = 500;
const AGENTS_CONFIG = resolve(process.cwd(), "config/agents.json");
const APPROVAL_DEBOUNCE_MS = 1500;

const AGENT_PROMPT_PATTERNS = {
    CONFIRMATION: [
        /Are you sure\?/i,
        /\[y\/n\]/i,
        /Apply these changes\?/i,
        /Confirm\?/i,
        /Do you want to proceed\?/i,
        /Press enter to continue/i,
        /continue\?/i,
        /proceed\?/i,
    ],
    PROGRESS: [/(\d{1,3})%/g, /processing/i, /analyzing/i, /downloading/i, /installing/i],
    ERROR: [/error/i, /fail/i, /exception/i],
};

function shellQuote(arg) {
    const s = String(arg ?? "");
    if (!s.length) return "\"\"";
    if (process.platform === "win32") {
        return `"${s.replace(/"/g, '\\"')}"`;
    }
    return `'${s.replace(/'/g, `'\\''`)}'`;
}

function buildShellCommand(command, args = []) {
    const all = [command, ...args].map((s) => shellQuote(s));
    return all.join(" ");
}

function psQuote(arg) {
    const s = String(arg ?? "");
    return `'${s.replace(/'/g, "''")}'`;
}

function buildPowerShellCommand(command, args = []) {
    const cmd = psQuote(command);
    const rest = args.map((a) => psQuote(a)).join(" ");
    return rest ? `& ${cmd} ${rest}` : `& ${cmd}`;
}

async function loadNodePty() {
    try {
        const mod = await import("node-pty");
        return mod;
    } catch {
        return null;
    }
}

function loadExternalAgentConfig() {
    try {
        if (!existsSync(AGENTS_CONFIG)) return {};
        const cfg = JSON.parse(readFileSync(AGENTS_CONFIG, "utf-8"));
        return cfg.externalAgents ?? {};
    } catch {
        return {};
    }
}

function getProtectedPathPatterns() {
    const cfg = loadExternalAgentConfig();
    const raw = Array.isArray(cfg.protectedPathPatterns)
        ? cfg.protectedPathPatterns
        : ["src/engine/evolve.js", "config/", ".env"];
    return raw.map((s) => {
        try { return new RegExp(String(s), "i"); } catch { return null; }
    }).filter(Boolean);
}

function evaluateRisk({ commandLine = "", output = "", protectedPatterns = [] }) {
    const haystack = `${commandLine}\n${output}`.toLowerCase();
    if (/(^|\s)(rm\s+-rf|del\s+\/[sq]|rd\s+\/[sq]|format\s+|shutdown|reboot)(\s|$)/i.test(haystack)) {
        return "critical";
    }
    if (protectedPatterns.some((p) => p.test(haystack))) {
        return "high";
    }
    if (/(npm\s+(install|i)|pnpm\s+install|yarn\s+add|npm\s+run\s+(build|test)|pnpm\s+(build|test)|yarn\s+(build|test))/i.test(haystack)) {
        return "medium";
    }
    return "low";
}

function parseProgress(output) {
    const match = String(output).match(/(\d{1,3})%/);
    if (!match) return null;
    const p = Math.max(0, Math.min(100, Number(match[1])));
    return Number.isFinite(p) ? p : null;
}

function buildAgentCommand(agentName, taskPrompt) {
    const cfg = loadExternalAgentConfig();
    const fromConfig = cfg[agentName];
    if (fromConfig?.command) {
        const argsTpl = Array.isArray(fromConfig.argsTemplate) ? fromConfig.argsTemplate : ["{prompt}"];
        const args = argsTpl.map((s) => String(s).replaceAll("{prompt}", taskPrompt));
        const stdinPrompt = fromConfig.promptViaStdin ? taskPrompt : null;
        const extraEnvRaw = (fromConfig.env && typeof fromConfig.env === "object") ? fromConfig.env : {};
        const extraEnv = { ...extraEnvRaw };
        const envStrip = Array.isArray(fromConfig.envStrip) ? fromConfig.envStrip : null;
        const useShell = typeof fromConfig.useShell === "boolean" ? fromConfig.useShell : true;
        return { command: fromConfig.command, args, stdinPrompt, extraEnv, envStrip, useShell };
    }

    if (agentName === "codex") {
        const codexArgs = [
            "--disable", "elevated_windows_sandbox",
            "--disable", "experimental_windows_sandbox",
            "-c", "suppress_unstable_features_warning=true",
            "exec", "--json", "-",
        ];
        if (process.platform === "win32") {
            // Win11 下显式走 PowerShell，避免 shell:true 默认落到 cmd.exe 造成环境差异
            const cmdline = `codex ${codexArgs.join(" ")}`;
            return {
                command: "powershell.exe",
                args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", cmdline],
                stdinPrompt: taskPrompt,
                extraEnv: {
                    NPM_CONFIG_LOGLEVEL: "silent",
                    NPM_CONFIG_PROGRESS: "false",
                    npm_config_loglevel: "silent",
                    npm_config_progress: "false",
                },
                envStrip: ["OPENAI_BASE_URL", "OPENAI_API_BASE"],
                useShell: false,
            };
        }
        return {
            command: "codex",
            args: codexArgs,
            stdinPrompt: taskPrompt,
            extraEnv: {
                NPM_CONFIG_LOGLEVEL: "silent",
                NPM_CONFIG_PROGRESS: "false",
                npm_config_loglevel: "silent",
                npm_config_progress: "false",
            },
            envStrip: ["OPENAI_BASE_URL", "OPENAI_API_BASE"],
            useShell: false,
        };
    }
    if (agentName === "claude") return { command: "claude", args: [taskPrompt] };
    if (agentName === "cursor") return { command: "cursor-agent", args: [taskPrompt] };
    return null;
}

export class TerminalController extends EventEmitter {
    constructor({
        id,
        agentName,
        command,
        args,
        stdinPrompt = null,
        envStrip = null,
        useShell = true,
        autoApprove = true,
        timeoutMs = DEFAULT_TTL_MS,
        cwd = process.cwd(),
        env = process.env,
        extraEnv = null,
        taskPrompt = "",
    }) {
        super();
        this.id = id;
        this.agentName = agentName;
        this.command = command;
        this.args = args;
        this.stdinPrompt = stdinPrompt;
        this.envStrip = Array.isArray(envStrip) ? envStrip : [];
        this.useShell = useShell;
        this.autoApprove = autoApprove;
        this.timeoutMs = timeoutMs;
        this.cwd = cwd;
        this.env = env;
        this.extraEnv = extraEnv;
        this.taskPrompt = taskPrompt;
        this.proc = null;
        this.pty = null;
        this.ptyMode = false;
        this.timer = null;
        this.finished = false;
        this.awaitingApproval = false;
        this.lastApprovalTs = 0;
        this.protectedPatterns = getProtectedPathPatterns();
    }

    async execute() {
        const mergedEnv = { ...this.env, ...(this.extraEnv ?? {}) };
        for (const k of this.envStrip) {
            if (k in mergedEnv) delete mergedEnv[k];
        }
        const codexHome = mergedEnv.CODEX_HOME;
        if (typeof codexHome === "string" && codexHome.trim()) {
            try {
                mkdirSync(codexHome, { recursive: true });
            } catch {
                // Let downstream process report a clearer filesystem permission error.
            }
        }

        this.emit("start", {
            id: this.id,
            agentName: this.agentName,
            command: this.command,
            args: this.args,
        });

        this.timer = setTimeout(() => {
            this.stop("timeout");
        }, this.timeoutMs);

        const ptyMod = await loadNodePty();
        if (ptyMod?.spawn) {
            const isWin = process.platform === "win32";
            const shellCommand = this.useShell
                ? (isWin ? buildPowerShellCommand(this.command, this.args) : buildShellCommand(this.command, this.args))
                : null;
            const launch = this.useShell
                ? (
                    isWin
                        ? {
                            cmd: "powershell.exe",
                            args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", shellCommand],
                        }
                        : {
                            cmd: process.env.SHELL || "/bin/bash",
                            args: ["-lc", shellCommand],
                        }
                )
                : (
                    isWin
                        ? {
                            // node-pty 在 Windows 下对 PATH 解析比 PowerShell 更严格，统一包装避免 error code 2
                            cmd: "powershell.exe",
                            args: [
                                "-NoLogo",
                                "-NoProfile",
                                "-NonInteractive",
                                "-ExecutionPolicy",
                                "Bypass",
                                "-Command",
                                buildPowerShellCommand(this.command, this.args),
                            ],
                        }
                        : { cmd: this.command, args: this.args }
                );

            this.pty = ptyMod.spawn(launch.cmd, launch.args, {
                name: "xterm-color",
                cols: 120,
                rows: 30,
                cwd: this.cwd,
                env: mergedEnv,
            });
            this.ptyMode = true;

            this.pty.onData((chunk) => {
                this.emit("log", chunk);
                this.handleOutput(chunk);
            });
            this.pty.onExit(({ exitCode, signal }) => {
                if (this.finished) return;
                this.finished = true;
                clearTimeout(this.timer);
                this.emit("exit", { code: exitCode, signal: String(signal ?? ""), reason: "exit" });
            });

            if (typeof this.stdinPrompt === "string" && this.stdinPrompt.length > 0) {
                this.pty.write(this.stdinPrompt);
                this.pty.write("\r");
            }
            return;
        }

        this.proc = spawn(this.command, this.args, {
            shell: this.useShell,
            cwd: this.cwd,
            env: mergedEnv,
            stdio: ["pipe", "pipe", "pipe"],
        });

        if (typeof this.stdinPrompt === "string" && this.stdinPrompt.length > 0) {
            this.proc.stdin.write(this.stdinPrompt);
            this.proc.stdin.write("\n");
            this.proc.stdin.end();
        }

        this.proc.stdout.on("data", (buf) => {
            const output = String(buf);
            this.emit("log", output);
            this.handleOutput(output);
        });

        this.proc.stderr.on("data", (buf) => {
            const output = String(buf);
            this.emit("error_log", output);
            this.handleOutput(output);
        });

        this.proc.on("close", (code, signal) => {
            if (this.finished) return;
            this.finished = true;
            clearTimeout(this.timer);
            this.emit("exit", { code, signal, reason: "exit" });
        });

        this.proc.on("error", (err) => {
            if (this.finished) return;
            this.finished = true;
            clearTimeout(this.timer);
            this.emit("exit", { code: -1, signal: "error", reason: err.message });
        });
    }

    handleOutput(output) {
        const p = parseProgress(output);
        if (p !== null) {
            this.emit("progress", p);
        }

        const asksConfirm = AGENT_PROMPT_PATTERNS.CONFIRMATION.some((pattern) => pattern.test(output));
        if (!asksConfirm) return;
        this.handleApprovalPrompt(output).catch((err) => {
            this.emit("approval_result", {
                approved: false,
                decision: "reject",
                reason: err?.message || "审批流程异常",
            });
            this.sendInput("n\n");
        });
    }

    async handleApprovalPrompt(output) {
        const now = Date.now();
        if (this.awaitingApproval) return;
        if (now - this.lastApprovalTs < APPROVAL_DEBOUNCE_MS) return;
        this.lastApprovalTs = now;
        this.awaitingApproval = true;

        const clipped = String(output).slice(-500);
        const commandLine = `${this.command} ${(this.args || []).join(" ")}\n${this.taskPrompt || ""}`;
        const risk = evaluateRisk({
            commandLine,
            output: clipped,
            protectedPatterns: this.protectedPatterns,
        });

        try {
            if (this.autoApprove && risk === "low") {
                this.sendInput("y\n");
                this.emit("auto_approved", { text: clipped, risk });
                this.emit("approval_result", { approved: true, decision: "approve", risk });
                return;
            }

            this.emit("prompt", { text: clipped, protectedHit: risk !== "low", risk });

            const approval = await approvalManager.requestApproval({
                actionType: "external_agent_prompt",
                risk,
                command: commandLine,
                message: `${this.agentName} 请求确认输入（风险：${risk}）`,
                allowModify: false,
                metadata: {
                    source: "external_agent",
                    taskId: this.id,
                    agentName: this.agentName,
                    prompt: clipped,
                },
            });

            if (approval.approved) {
                this.sendInput("y\n");
            } else {
                this.sendInput("n\n");
            }
            this.emit("approval_result", {
                approved: !!approval.approved,
                decision: approval.decision || (approval.approved ? "approve" : "reject"),
                reason: approval.reason || "",
                risk,
            });
        } finally {
            this.awaitingApproval = false;
        }
    }

    sendInput(text) {
        if (this.finished) return false;
        const normalized = String(text ?? "");
        if (this.pty && this.ptyMode) {
            this.pty.write(normalized.replace(/\n/g, "\r"));
            return true;
        }
        if (!this.proc) return false;
        this.proc.stdin.write(normalized);
        return true;
    }

    resize(cols, rows) {
        if (!this.pty || !this.ptyMode) return false;
        const c = Math.max(20, Number(cols) || 120);
        const r = Math.max(8, Number(rows) || 30);
        this.pty.resize(c, r);
        return true;
    }

    stop(reason = "manual") {
        if (this.finished) return;
        if (this.pty && this.ptyMode) {
            this.pty.kill();
        }
        if (this.proc) {
            this.proc.kill("SIGTERM");
        }
        this.finished = true;
        clearTimeout(this.timer);
        this.emit("exit", { code: -1, signal: "SIGTERM", reason });
    }
}

class TerminalTaskManager {
    constructor() {
        this.tasks = new Map();
    }

    startTask({ agentName, taskPrompt, autoApprove = true, timeoutMs = DEFAULT_TTL_MS }) {
        const plan = buildAgentCommand(agentName, taskPrompt);
        if (!plan) {
            throw new Error(`未配置外部代理：${agentName}`);
        }

        const id = `term_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
        const startedAt = Date.now();
        const task = {
            id,
            agentName,
            taskPrompt,
            command: plan.command,
            args: plan.args,
            stdinPrompt: plan.stdinPrompt ?? null,
            autoApprove,
            timeoutMs,
            extraEnv: plan.extraEnv ?? null,
            envStrip: plan.envStrip ?? null,
            taskPrompt,
            useShell: typeof plan.useShell === "boolean" ? plan.useShell : true,
            status: "running",
            startedAt,
            endedAt: null,
            exitCode: null,
            reason: "",
            progress: 0,
            logs: [],
            waiters: [],
        };

        const controller = new TerminalController({
            id,
            agentName,
            command: plan.command,
            args: plan.args,
            stdinPrompt: plan.stdinPrompt ?? null,
            autoApprove,
            timeoutMs,
            extraEnv: plan.extraEnv ?? null,
            envStrip: plan.envStrip ?? null,
            taskPrompt,
            useShell: typeof plan.useShell === "boolean" ? plan.useShell : true,
            cwd: process.cwd(),
        });
        task.controller = controller;
        this.tasks.set(id, task);

        const pushLog = (kind, output) => {
            const line = `[${kind}] ${output}`;
            task.logs.push(line);
            if (task.logs.length > LOG_LIMIT) task.logs = task.logs.slice(-LOG_LIMIT);
        };

        controller.on("start", () => {
            agentBus.push("terminal.start", "fire", `外部代理启动：${agentName}`, { taskId: id, agentName });
        });
        controller.on("log", (output) => {
            pushLog("stdout", output);
            agentBus.push("terminal.stream", "fire", `[${agentName}] 输出流`, {
                taskId: id, agentName, stream: "stdout", chunk: output,
            });
        });
        controller.on("error_log", (output) => {
            pushLog("stderr", output);
            agentBus.push("terminal.stream", "fire", `[${agentName}] 错误流`, {
                taskId: id, agentName, stream: "stderr", chunk: output,
            });
        });
        controller.on("progress", (progress) => {
            task.progress = progress;
            agentBus.push("terminal.progress", "fire", `任务进度 ${progress}%`, {
                taskId: id, agentName, progress,
            });
        });
        controller.on("prompt", ({ text, protectedHit }) => {
            task.status = "waiting_input";
            agentBus.push("terminal.prompt", "metal", "终端等待确认输入", {
                taskId: id, agentName, text, protectedHit,
            });
        });
        controller.on("auto_approved", ({ text }) => {
            agentBus.push("terminal.auto_approved", "metal", "检测到交互提问，已自动确认", {
                taskId: id, agentName, text,
            });
        });
        controller.on("approval_result", ({ approved, decision, reason = "", risk = "high" }) => {
            task.status = approved ? "running" : "waiting_input";
            agentBus.push("terminal.approval_result", "metal", "终端审批结果", {
                taskId: id,
                agentName,
                approved,
                decision,
                reason,
                risk,
            });
        });
        controller.on("exit", ({ code, reason }) => {
            if (task.logs.length === 0) {
                const msg = `[terminal] process exited (code=${code}, reason=${reason || "exit"})\n`;
                pushLog("stderr", msg);
                agentBus.push("terminal.stream", "fire", `[${agentName}] 退出信息`, {
                    taskId: id, agentName, stream: "stderr", chunk: msg,
                });
            }
            task.status = "finished";
            task.endedAt = Date.now();
            task.exitCode = code;
            task.reason = reason;
            agentBus.push("terminal.exit", "fire", `外部代理结束：${agentName}（code=${code}）`, {
                taskId: id, agentName, code, reason,
            });
            const finalSummary = this.getTaskSnapshot(id);
            for (const fn of task.waiters) fn(finalSummary);
            task.waiters = [];
        });

        controller.execute().catch((err) => {
            const msg = `[terminal] execute error: ${err?.message || "unknown"}\n`;
            pushLog("stderr", msg);
            agentBus.push("terminal.stream", "fire", `[${agentName}] 执行异常`, {
                taskId: id,
                agentName,
                stream: "stderr",
                chunk: msg,
            });
            task.status = "finished";
            task.endedAt = Date.now();
            task.exitCode = -1;
            task.reason = err?.message || "执行失败";
            agentBus.push("terminal.exit", "fire", `外部代理异常退出：${agentName}`, {
                taskId: id,
                agentName,
                code: -1,
                reason: task.reason,
            });
        });
        return this.getTaskSnapshot(id);
    }

    getTaskSnapshot(id) {
        const task = this.tasks.get(id);
        if (!task) return null;
        return {
            id: task.id,
            agentName: task.agentName,
            taskPrompt: task.taskPrompt,
            command: task.command,
            args: task.args,
            autoApprove: task.autoApprove,
            timeoutMs: task.timeoutMs,
            status: task.status,
            startedAt: task.startedAt,
            endedAt: task.endedAt,
            exitCode: task.exitCode,
            reason: task.reason,
            progress: task.progress,
            logsTail: task.logs.slice(-80),
        };
    }

    listTasks() {
        return [...this.tasks.keys()].map((id) => this.getTaskSnapshot(id));
    }

    sendInput(id, text) {
        const task = this.tasks.get(id);
        if (!task) return false;
        const ok = task.controller?.sendInput(text);
        if (ok) task.status = "running";
        return !!ok;
    }

    resizeTask(id, cols, rows) {
        const task = this.tasks.get(id);
        if (!task) return false;
        return !!task.controller?.resize(cols, rows);
    }

    stopTask(id) {
        const task = this.tasks.get(id);
        if (!task) return false;
        task.controller?.stop("manual_stop");
        return true;
    }

    waitForExit(id) {
        const task = this.tasks.get(id);
        if (!task) return Promise.resolve(null);
        if (task.status === "finished") return Promise.resolve(this.getTaskSnapshot(id));
        return new Promise((resolveWait) => {
            task.waiters.push(resolveWait);
        });
    }
}

export const terminalTaskManager = new TerminalTaskManager();
