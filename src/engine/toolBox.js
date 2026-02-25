// src/engine/toolBox.js
// 【火-工具箱】：Agent 的"手脚"—— 文件读写 + 代码执行
//
// 安全边界（金之约束）：
//   read_file       — 只允许读取项目根目录内的文件
//   write_file      — 只允许写入 workspace/ 目录（Agent 的合法道场）
//   execute_code    — 子进程运行，带超时，stdout/stderr 截断
//   list_workspace  — 展示 workspace/ 现有产出，水层启动感知
//   list_dir        — 探索项目结构（只读）
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { readFile, writeFile, readdir, mkdir, unlink, stat } from "fs/promises";
import { existsSync } from "fs";
import { execFile } from "child_process";
import { promisify } from "util";
import { join, resolve, dirname, basename } from "path";
import { fileURLToPath } from "url";
import cfg from "../../config/wuxing.json" with { type: "json" };

const execFileAsync = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));

export const PROJECT_ROOT  = resolve(join(__dirname, "../../"));
export const WORKSPACE_DIR = join(PROJECT_ROOT, cfg.tools.workspaceDir);

// ── 确保工作区目录存在 ────────────────────────────────────
async function ensureWorkspace() {
    if (!existsSync(WORKSPACE_DIR)) {
        await mkdir(WORKSPACE_DIR, { recursive: true });
    }
}

// ── 工具 1：读取文件 ─────────────────────────────────────
export const readFileTool = tool(
    async ({ path, maxChars = 4000 }) => {
        try {
            const abs = resolve(PROJECT_ROOT, path);
            if (!abs.startsWith(resolve(PROJECT_ROOT))) {
                return `【错误】路径越界：${path}`;
            }
            const content = await readFile(abs, "utf-8");
            const truncated = content.length > maxChars
                ? content.slice(0, maxChars) + `\n…（已截断，原文件 ${content.length} 字符）`
                : content;
            return `【文件内容：${path}】\n${truncated}`;
        } catch (e) {
            return `【错误】读取失败：${e.message}`;
        }
    },
    {
        name: "read_file",
        description: "读取项目根目录内的文件内容。路径相对于项目根目录，如 'src/engine/wuxingGraph.js' 或 'package.json'。",
        schema: z.object({
            path:     z.string().describe("相对于项目根目录的文件路径"),
            maxChars: z.number().optional().describe("最多返回的字符数，默认 4000"),
        }),
    }
);

// ── 工具 2：列出目录 ─────────────────────────────────────
export const listDirTool = tool(
    async ({ path = ".", depth = 1 }) => {
        try {
            const abs = resolve(PROJECT_ROOT, path);
            if (!abs.startsWith(resolve(PROJECT_ROOT))) {
                return `【错误】路径越界：${path}`;
            }
            const entries = await readdir(abs, { withFileTypes: true });
            const lines = [];
            for (const e of entries) {
                if (e.name.startsWith(".") || e.name === "node_modules") continue;
                const type = e.isDirectory() ? "[DIR]" : "[FILE]";
                lines.push(`${type} ${e.name}`);
                if (e.isDirectory() && depth > 1) {
                    try {
                        const sub = await readdir(join(abs, e.name), { withFileTypes: true });
                        for (const s of sub) {
                            if (s.name.startsWith(".") || s.name === "node_modules") continue;
                            lines.push(`  ${s.isDirectory() ? "[DIR]" : "[FILE]"} ${s.name}`);
                        }
                    } catch { /* skip */ }
                }
            }
            return `【目录：${path}】\n${lines.join("\n")}`;
        } catch (e) {
            return `【错误】列目录失败：${e.message}`;
        }
    },
    {
        name: "list_dir",
        description: "列出目录内容（跳过隐藏文件和 node_modules）。路径相对于项目根目录。",
        schema: z.object({
            path:  z.string().optional().describe("相对于项目根目录的路径，默认为根目录"),
            depth: z.number().optional().describe("展开深度（1=当前层，2=含一级子目录），默认 1"),
        }),
    }
);

// ── 工具 3：写入文件（工作区内）──────────────────────────
export const writeFileTool = tool(
    async ({ filename, content }) => {
        try {
            await ensureWorkspace();
            // basename 防路径穿越（Windows/Linux 均有效）
            const safeFile = basename(filename);
            const abs      = join(WORKSPACE_DIR, safeFile);
            await writeFile(abs, content, "utf-8");
            // 返回绝对路径——Windows 下可直接在控制台点击定位
            return `【写入成功】${abs}\n（${content.length} 字符，文件名：${safeFile}）`;
        } catch (e) {
            return `【写入失败】${e.message}`;
        }
    },
    {
        name: "write_file",
        description: "将内容写入 workspace/ 目录（Agent 的专属代码产出地，安全隔离）。写完可用 execute_code 运行。",
        schema: z.object({
            filename: z.string().describe("文件名，如 'safe_read.js'（自动存入 workspace/，不含路径）"),
            content:  z.string().describe("文件内容"),
        }),
    }
);

// ── 工具 4：执行 Node.js 代码（工作区 + 超时）────────────
export const executeCodeTool = tool(
    async ({ filename = "agent_run.js", timeoutMs = 8000 }) => {
        try {
            await ensureWorkspace();
            const safeFile = basename(filename);
            const filePath = join(WORKSPACE_DIR, safeFile);
            if (!existsSync(filePath)) {
                return `【执行失败】找不到文件：${filePath}\n请先用 write_file 写入该文件。`;
            }

            const { stdout, stderr } = await execFileAsync(
                process.execPath,
                [filePath],
                {
                    timeout:   timeoutMs,
                    cwd:       WORKSPACE_DIR,
                    env:       { ...process.env },
                    maxBuffer: 64 * 1024,
                }
            );

            const output = stdout.slice(0, 3000) || "(无标准输出)";
            const errOut = stderr ? `\n[stderr] ${stderr.slice(0, 500)}` : "";
            return `【执行完成】${filePath}\n${output}${errOut}`;
        } catch (e) {
            const msg    = e.killed ? `超时（>${timeoutMs}ms）` : e.message;
            const stderr = e.stderr ? `\n[stderr] ${e.stderr.slice(0, 500)}` : "";
            return `【执行错误】${join(WORKSPACE_DIR, basename(filename))}\n${msg}${stderr}`;
        }
    },
    {
        name: "execute_code",
        description: "在 workspace/ 目录下执行已有的 Node.js 文件。文件必须先用 write_file 写入，有超时保护。",
        schema: z.object({
            filename:  z.string().optional().describe("要执行的文件名（默认 agent_run.js）"),
            timeoutMs: z.number().optional().describe("超时毫秒数（默认 8000）"),
        }),
    }
);

// ── 工具 5：查看工作区（水层启动感知）────────────────────
export const listWorkspaceTool = tool(
    async ({ showSize = false }) => {
        try {
            await ensureWorkspace();
            const entries = await readdir(WORKSPACE_DIR, { withFileTypes: true });
            const files   = entries.filter((e) => e.isFile());

            if (files.length === 0) {
                return "【工作区为空】暂无产出文件，可用 write_file 写入代码。";
            }

            const lines = [`【工作区：workspace/ 共 ${files.length} 个文件】`];
            for (const f of files) {
                let line = `  - ${f.name}`;
                if (showSize) {
                    try {
                        const s = await stat(join(WORKSPACE_DIR, f.name));
                        line += ` (${(s.size / 1024).toFixed(1)} KB)`;
                    } catch { /* skip */ }
                }
                lines.push(line);
            }
            return lines.join("\n");
        } catch (e) {
            return `【错误】读取工作区失败：${e.message}`;
        }
    },
    {
        name: "list_workspace",
        description: "查看 workspace/ 目录中已有的代码产出文件，用于了解当前工作上下文。",
        schema: z.object({
            showSize: z.boolean().optional().describe("是否显示文件大小，默认 false"),
        }),
    }
);

export const ALL_TOOLS = [
    readFileTool,
    listDirTool,
    writeFileTool,
    executeCodeTool,
    listWorkspaceTool,
];
