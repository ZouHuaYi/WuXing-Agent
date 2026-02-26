import { EventEmitter } from "events";
import { spawn } from "child_process";
import { readFileSync, existsSync } from "fs";
import { resolve } from "path";
import { agentBus } from "./eventBus.js";

const DEFAULT_TTL_MS = 10 * 60 * 1000;
const LOG_LIMIT = 500;
const AGENTS_CONFIG = resolve(process.cwd(), "config/agents.json");

const APPROVAL_PATTERNS = [
    /Are you sure\?/i,
    /\[y\/n\]/i,
    /Apply these changes\?/i,
    /Confirm\?/i,
    /Do you want to proceed\?/i,
    /Press enter to continue/i,
];

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

function buildAgentCommand(agentName, taskPrompt) {
    const cfg = loadExternalAgentConfig();
    const fromConfig = cfg[agentName];
    if (fromConfig?.command) {
        const argsTpl = Array.isArray(fromConfig.argsTemplate) ? fromConfig.argsTemplate : ["{prompt}"];
        const args = argsTpl.map((s) => String(s).replaceAll("{prompt}", taskPrompt));
        const stdinPrompt = fromConfig.promptViaStdin ? taskPrompt : null;
        const extraEnv = (fromConfig.env && typeof fromConfig.env === "object") ? fromConfig.env : null;
        const envStrip = Array.isArray(fromConfig.envStrip) ? fromConfig.envStrip : null;
        return { command: fromConfig.command, args, stdinPrompt, extraEnv, envStrip, useShell: true };
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
                args: ["-NoLogo", "-Command", cmdline],
                stdinPrompt: taskPrompt,
                envStrip: ["OPENAI_BASE_URL", "OPENAI_API_BASE", "OPENAI_API_KEY"],
                useShell: false,
            };
        }
        return {
            command: "codex",
            args: codexArgs,
            stdinPrompt: taskPrompt,
            envStrip: ["OPENAI_BASE_URL", "OPENAI_API_BASE", "OPENAI_API_KEY"],
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
        this.proc = null;
        this.timer = null;
        this.finished = false;
    }

    execute() {
        const mergedEnv = { ...this.env, ...(this.extraEnv ?? {}) };
        for (const k of this.envStrip) {
            if (k in mergedEnv) delete mergedEnv[k];
        }

        this.proc = spawn(this.command, this.args, {
            shell: this.useShell,
            cwd: this.cwd,
            env: mergedEnv,
            stdio: ["pipe", "pipe", "pipe"],
        });

        this.emit("start", {
            id: this.id,
            agentName: this.agentName,
            command: this.command,
            args: this.args,
        });

        this.timer = setTimeout(() => {
            this.stop("timeout");
        }, this.timeoutMs);

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
        const progressMatch = output.match(/(\d{1,3})%/);
        if (progressMatch) {
            const p = Math.max(0, Math.min(100, Number(progressMatch[1])));
            this.emit("progress", p);
        }

        const protectedPatterns = getProtectedPathPatterns();
        const sensitiveTouched = protectedPatterns.some((p) => p.test(output));
        const asksConfirm = APPROVAL_PATTERNS.some((p) => p.test(output));
        if (!asksConfirm) return;

        if (sensitiveTouched) {
            this.emit("prompt", {
                text: output.slice(-500),
                protectedHit: true,
            });
            return;
        }

        if (this.autoApprove) {
            this.proc?.stdin?.write("y\n");
            this.emit("auto_approved", { text: output.slice(-300) });
            return;
        }

        this.emit("prompt", {
            text: output.slice(-500),
            protectedHit: false,
        });
    }

    sendInput(text) {
        if (!this.proc || this.finished) return false;
        this.proc.stdin.write(String(text));
        return true;
    }

    stop(reason = "manual") {
        if (!this.proc || this.finished) return;
        this.proc.kill("SIGTERM");
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
        controller.on("exit", ({ code, reason }) => {
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

        controller.execute();
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
