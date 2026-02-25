// src/engine/toolBox.js
// 【火-工具箱】：Agent 的"手脚"—— 文件读写 + 代码执行
//
// 安全边界（金之约束）：
//   read_file  — 只允许读取项目根目录内的文件
//   write_file — 只允许写入 data/sandbox/ 目录
//   execute_code — 在子进程中运行，带超时，stdout/stderr 截断
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { readFile, writeFile, readdir, mkdir, stat } from "fs/promises";
import { existsSync } from "fs";
import { execFile } from "child_process";
import { promisify } from "util";
import { join, resolve, dirname } from "path";
import { fileURLToPath } from "url";

const execFileAsync = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));

export const PROJECT_ROOT = resolve(join(__dirname, "../../"));
export const SANDBOX_DIR  = join(PROJECT_ROOT, "data", "sandbox");

// ── 路径安全校验 ─────────────────────────────────────────
function assertInRoot(inputPath, root = PROJECT_ROOT) {
    const abs = resolve(root, inputPath);
    if (!abs.startsWith(resolve(root))) {
        throw new Error(`路径越界：${inputPath}`);
    }
    return abs;
}

// ── 工具 1：读取文件 ─────────────────────────────────────
export const readFileTool = tool(
    async ({ path, maxChars = 4000 }) => {
        try {
            const abs = assertInRoot(path);
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
        description: "读取项目根目录内的文件内容。路径相对于项目根目录，如 'src/engine/wuxingGraph.js'。",
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
            const abs = assertInRoot(path);
            const entries = await readdir(abs, { withFileTypes: true });
            const lines = [];
            for (const e of entries) {
                if (e.name.startsWith(".") || e.name === "node_modules") continue;
                const type = e.isDirectory() ? "📁" : "📄";
                lines.push(`${type} ${e.name}`);
                // 一级子目录展开
                if (e.isDirectory() && depth > 1) {
                    try {
                        const sub = await readdir(join(abs, e.name), { withFileTypes: true });
                        for (const s of sub) {
                            if (s.name.startsWith(".") || s.name === "node_modules") continue;
                            lines.push(`  ${s.isDirectory() ? "📁" : "📄"} ${s.name}`);
                        }
                    } catch { /* skip unreadable */ }
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

// ── 工具 3：写入文件（沙箱内）────────────────────────────
export const writeFileTool = tool(
    async ({ filename, content }) => {
        try {
            if (!existsSync(SANDBOX_DIR)) {
                await mkdir(SANDBOX_DIR, { recursive: true });
            }
            // 只允许写入 sandbox 目录，防止越权
            const abs = assertInRoot(filename, SANDBOX_DIR);
            await writeFile(abs, content, "utf-8");
            return `【写入成功】${SANDBOX_DIR}/${filename}（${content.length} 字符）`;
        } catch (e) {
            return `【错误】写入失败：${e.message}`;
        }
    },
    {
        name: "write_file",
        description: "将内容写入 data/sandbox/ 目录中的文件（安全沙箱，不可写入沙箱外）。",
        schema: z.object({
            filename: z.string().describe("文件名，如 'hello.js'（不含路径，自动存入 data/sandbox/）"),
            content:  z.string().describe("文件内容"),
        }),
    }
);

// ── 工具 4：执行 Node.js 代码（沙箱 + 超时）────────────────
export const executeCodeTool = tool(
    async ({ filename = "agent_run.js", timeoutMs = 8000 }) => {
        try {
            if (!existsSync(SANDBOX_DIR)) {
                await mkdir(SANDBOX_DIR, { recursive: true });
            }
            const filePath = join(SANDBOX_DIR, filename);
            if (!existsSync(filePath)) {
                return `【错误】文件 ${filename} 不存在于沙箱，请先用 write_file 写入。`;
            }

            const { stdout, stderr } = await execFileAsync(
                process.execPath, // 使用当前 Node.js 可执行文件
                [filePath],
                {
                    timeout: timeoutMs,
                    cwd: SANDBOX_DIR,
                    env: { ...process.env },
                    maxBuffer: 64 * 1024, // 最多 64KB 输出
                }
            );

            const output = stdout.slice(0, 3000) || "(无标准输出)";
            const errOut = stderr ? `\n[stderr] ${stderr.slice(0, 500)}` : "";
            return `【执行完成：${filename}】\n${output}${errOut}`;
        } catch (e) {
            const msg = e.killed ? `超时（>${e.code}ms）` : e.message;
            const stderr = e.stderr ? `\n[stderr] ${e.stderr.slice(0, 500)}` : "";
            return `【执行错误：${filename}】${msg}${stderr}`;
        }
    },
    {
        name: "execute_code",
        description: "在安全沙箱中执行 data/sandbox/ 目录下已有的 Node.js 文件。文件必须先用 write_file 写入。",
        schema: z.object({
            filename:  z.string().optional().describe("要执行的文件名（默认 agent_run.js）"),
            timeoutMs: z.number().optional().describe("超时毫秒数（默认 8000）"),
        }),
    }
);

export const ALL_TOOLS = [readFileTool, listDirTool, writeFileTool, executeCodeTool];
