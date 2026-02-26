// src/engine/toolBox.js
// 【火-工具箱】：Agent 的"手脚"—— 文件读写 + 代码执行 + 自进化
//
// 安全边界（金之约束）：
//   read_file          — 读取项目根目录内的任意文件（含配置、技能定义）
//   write_file         — 只允许写入 workspace/ 目录（Agent 的合法道场）
//   execute_code       — 子进程运行，带超时，stdout/stderr 截断
//   list_workspace     — 展示 workspace/ 现有产出，水层启动感知
//   list_dir           — 探索项目结构（只读）
//   incorporate_skill  — 将 workspace/ 中测试通过的代码提升为正式技能卡
//   install_npm_package— 按需安装 npm 包（受包名格式限制，禁止全局安装）
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { readFile, writeFile, readdir, mkdir, unlink, stat } from "fs/promises";
import { existsSync } from "fs";
import { execFile } from "child_process";
import { promisify } from "util";
import { join, resolve, dirname, basename } from "path";
import { fileURLToPath } from "url";
import cfg from "../../config/wuxing.json" with { type: "json" };
import { approvalManager } from "./approvalManager.js";

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
        description:
            "读取项目根目录内的任意文件内容。路径相对于项目根目录。\n" +
            "可读取的关键文件包括：\n" +
            "  config/mcp.json        — MCP 服务配置\n" +
            "  config/wuxing.json     — 系统参数\n" +
            "  config/agents.json     — 角色定义\n" +
            "  skills/*/SKILL.md      — 技能卡定义\n" +
            "  package.json           — 依赖列表\n" +
            "  workspace/<文件名>     — 自己写的代码",
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

// ── 工具 6：测试运行器（写完即验，失败可自愈）────────────
// 运行 workspace/ 中的代码文件，返回结构化报告：
//   PASS — 含 stdout；FAIL — 含完整 stderr + stack + 修复建议索引
export const testRunnerTool = tool(
    async ({ filename, testCode, timeoutMs = 8000 }) => {
        try {
            await ensureWorkspace();
            const safeFile   = basename(filename);
            const targetPath = join(WORKSPACE_DIR, safeFile);

            if (!existsSync(targetPath)) {
                return `【测试失败】目标文件不存在：${targetPath}\n请先用 write_file 写入 ${safeFile}。`;
            }

            // 如果调用方提供了测试代码，写入临时测试文件后运行
            // 否则直接运行目标文件（验证基本可执行性）
            let runFile = targetPath;
            let tempTest = null;

            if (testCode) {
                const testName = `__test_${safeFile}`;
                tempTest = join(WORKSPACE_DIR, testName);
                // 在测试代码头部注入 require 路径，确保能引用目标文件
                const testContent =
                    `// auto-generated test wrapper\n` +
                    `process.chdir(${JSON.stringify(WORKSPACE_DIR)});\n` +
                    testCode;
                await writeFile(tempTest, testContent, "utf-8");
                runFile = tempTest;
            }

            let result;
            try {
                result = await execFileAsync(
                    process.execPath,
                    [runFile],
                    {
                        timeout:   timeoutMs,
                        cwd:       WORKSPACE_DIR,
                        env:       { ...process.env },
                        maxBuffer: 128 * 1024,
                    }
                );
            } finally {
                // 清理临时测试文件
                if (tempTest && existsSync(tempTest)) {
                    await unlink(tempTest).catch(() => {});
                }
            }

            const stdout = result.stdout.slice(0, 3000).trim() || "(无输出)";
            const stderr = result.stderr.slice(0, 500).trim();
            const report = [
                `【测试通过】${targetPath}`,
                `输出：\n${stdout}`,
                stderr ? `警告：\n${stderr}` : "",
            ].filter(Boolean).join("\n");

            return report;

        } catch (e) {
            // 结构化失败报告：区分超时 / 语法错误 / 运行时错误
            const isTimeout = e.killed || e.code === "ETIMEDOUT";
            const stderr    = (e.stderr ?? "").slice(0, 1500);
            const stdout    = (e.stdout ?? "").slice(0, 500);

            // 提取最关键的错误行（通常是第一行 Error: 或最后一行 at ...）
            const errorLines = stderr.split("\n").filter(Boolean);
            const errorHead  = errorLines.slice(0, 4).join("\n");
            const stackHint  = errorLines.find((l) => l.trim().startsWith("at ")) ?? "";

            const report = [
                isTimeout
                    ? `【测试超时】执行超过 ${timeoutMs}ms，可能存在死循环`
                    : `【测试失败】${join(WORKSPACE_DIR, basename(filename))}`,
                `错误摘要：\n${errorHead}`,
                stackHint ? `定位：${stackHint.trim()}` : "",
                stdout     ? `部分输出：\n${stdout}` : "",
                "\n修复建议：根据以上错误信息，用 write_file 重写目标文件，再调用 test_runner 重新验证。",
            ].filter(Boolean).join("\n");

            return report;
        }
    },
    {
        name: "test_runner",
        description:
            "运行 workspace/ 中的代码文件并返回结构化测试报告（PASS/FAIL + 详细堆栈）。" +
            "可选提供 testCode（字符串）作为独立测试脚本；不提供则直接运行目标文件。" +
            "失败时报告包含修复建议，配合 write_file 形成自愈闭环。",
        schema: z.object({
            filename:  z.string().describe("要测试的文件名（workspace/ 中已有的文件）"),
            testCode:  z.string().optional().describe("可选：独立的测试代码（会临时写入并运行，完成后自动删除）"),
            timeoutMs: z.number().optional().describe("超时毫秒数（默认 8000）"),
        }),
    }
);

// ── 工具 7：内化技能（workspace → skills/ 正式技能卡）────
//
// 将 workspace/ 中测试通过的 handler 文件提升为标准目录型技能卡：
//   skills/{name}/SKILL.md
//   skills/{name}/schema.json
//   skills/{name}/scripts/index.js
//
// 提升后自动触发 skillManager.refreshSkills() 热加载。
export const incorporateSkillTool = tool(
    async ({ name, sourceFile, description, parametersJson }) => {
        // ── 名称合规检查 ──
        if (!/^[a-z][a-z0-9_]{1,39}$/.test(name)) {
            return `【错误】技能名 "${name}" 不合规（只允许小写字母/数字/下划线，长度 2-40）`;
        }

        const srcPath  = join(WORKSPACE_DIR, basename(sourceFile));
        if (!existsSync(srcPath)) {
            return `【错误】源文件不存在：${srcPath}\n请先用 write_file 写入并用 test_runner 验证。`;
        }

        const skillsRoot = join(PROJECT_ROOT, "skills");
        const skillDir   = join(skillsRoot, name);
        const scriptsDir = join(skillDir, "scripts");

        if (existsSync(skillDir)) {
            return `【跳过】技能 ${name} 已存在：${skillDir}\n如需覆盖，请先手动删除该目录。`;
        }

        try {
            await mkdir(scriptsDir, { recursive: true });

            // 根据源文件扩展名决定 handler 文件名（.py 优先）
            const srcExt     = sourceFile.toLowerCase().endsWith(".py") ? ".py" : ".js";
            const handlerFile = `index${srcExt}`;
            const langLabel   = srcExt === ".py" ? "Python" : "Node.js";

            // SKILL.md
            const skillMd = [
                `---`,
                `name: ${name}`,
                `description: ${description}`,
                `---`,
                ``,
                `# ${name}`,
                ``,
                `> 由 Agent 自动内化（incorporate_skill）`,
                ``,
                `## 来源`,
                ``,
                `workspace/${basename(sourceFile)}（${langLabel}）`,
            ].join("\n");

            // schema.json（从 parametersJson 参数解析，默认空对象）
            let schema = { type: "object", properties: {}, required: [] };
            if (parametersJson) {
                try { schema = JSON.parse(parametersJson); } catch { /* 用默认值 */ }
            }

            const handlerCode = await readFile(srcPath, "utf-8");

            await writeFile(join(skillDir, "SKILL.md"),        skillMd,                      "utf-8");
            await writeFile(join(skillDir, "schema.json"),     JSON.stringify(schema, null, 2), "utf-8");
            await writeFile(join(scriptsDir, handlerFile),     handlerCode,                  "utf-8");

            // 热加载：动态导入 skillManager（避免模块加载时的循环依赖）
            try {
                const { skillManager } = await import("./skillManager.js");
                await skillManager.refreshSkills();
            } catch { /* main.js 中 skillManager 会在下次 :reload 时刷新 */ }

            return [
                `【内化成功】技能已写入 skills/${name}/`,
                `  SKILL.md              — 技能定义`,
                `  schema.json           — 参数规格`,
                `  scripts/${handlerFile} — 处理逻辑（${langLabel}，来自 workspace/${basename(sourceFile)}）`,
                `技能已热加载，可立即在对话中调用。`,
            ].join("\n");

        } catch (e) {
            return `【内化失败】${e.message}`;
        }
    },
    {
        name: "incorporate_skill",
        description:
            "将 workspace/ 中测试通过的代码文件提升为正式目录型技能卡（skills/{name}/）并自动热加载。\n" +
            "支持 Python（.py，推荐）和 Node.js（.js）两种 handler：\n" +
            "  .py — Python 脚本，通过 stdin/stdout JSON 通信，依赖用 pip 管理\n" +
            "  .js — ESM 模块，必须导出 export async function handler(args){}\n" +
            "必须先用 test_runner 验证代码无误，再调用此工具完成自进化闭环。",
        schema: z.object({
            name:           z.string().describe("技能标识符（snake_case，如 fetch_btc_price）"),
            sourceFile:     z.string().describe("workspace/ 中的源文件名（如 btc_fetcher.js）"),
            description:    z.string().describe("技能描述（第三人称，说明 WHAT + WHEN，≤120字符）"),
            parametersJson: z.string().optional().describe(
                "可选：JSON Schema 字符串，描述 handler 的输入参数。默认为空对象 schema。"
            ),
        }),
    }
);

// ── 工具 8：按需安装 npm 包 ────────────────────────────
//
// 安全限制：
//   - 包名必须符合 npm 命名规范（防注入）
//   - 禁止 --global 和其他危险标志
//   - 超时 120s（npm 网络慢时需要时间）
const NPM_NAME_RE = /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*(@[\d.]+)?$/;

export const installNpmPackageTool = tool(
    async ({ packageName, saveAs = "dependency" }) => {
        if (!NPM_NAME_RE.test(packageName)) {
            return `【拒绝】包名 "${packageName}" 格式非法（防注入保护）`;
        }

        const flag = saveAs === "devDependency" ? "--save-dev" : "--save";
        const installCmd = `npm install ${packageName} ${flag}`;

        if (approvalManager.shouldRequest("high")) {
            const approval = await approvalManager.requestApproval({
                actionType: "install_dependency",
                risk: "high",
                command: installCmd,
                message: `请求安装依赖：${packageName}（${saveAs}）`,
                allowModify: false,
                metadata: { source: "tool_install_npm_package", packageName, saveAs },
            });

            if (!approval.approved) {
                return `【审批拒绝】未执行安装：${packageName}（${approval.reason || "未获批准"}）`;
            }
        }

        try {
            const { stdout, stderr } = await execFileAsync(
                "npm",
                ["install", packageName, flag],
                {
                    timeout:   120_000,
                    cwd:       PROJECT_ROOT,
                    env:       { ...process.env },
                    maxBuffer: 256 * 1024,
                    shell:     true,   // Windows 下 npm 是 .cmd 脚本，需要 shell
                }
            );

            const out = (stdout || "").trim().slice(0, 1000);
            const err = (stderr || "").trim().slice(0, 400);
            return [
                `【安装成功】${packageName}`,
                out ? `输出：${out}` : "",
                err ? `警告：${err}` : "",
            ].filter(Boolean).join("\n");

        } catch (e) {
            const msg = e.killed ? "安装超时（>120s）" : e.message.slice(0, 300);
            const err = (e.stderr ?? "").slice(0, 400);
            return `【安装失败】${packageName}\n${msg}${err ? `\n${err}` : ""}`;
        }
    },
    {
        name: "install_npm_package",
        description:
            "按需安装 npm 包到项目依赖。安装后可在 workspace/ 代码中 require/import 使用。\n" +
            "示例：install axios 后，workspace 代码可直接 import axios from 'axios'。\n" +
            "限制：包名必须符合 npm 命名规范；不允许全局安装。",
        schema: z.object({
            packageName: z.string().describe("npm 包名，如 'axios' 或 '@scope/package'"),
            saveAs:      z.enum(["dependency", "devDependency"]).optional()
                          .describe("保存类型：dependency（默认）或 devDependency"),
        }),
    }
);

export const ALL_TOOLS = [
    readFileTool,
    listDirTool,
    writeFileTool,
    executeCodeTool,
    listWorkspaceTool,
    testRunnerTool,
    incorporateSkillTool,
    installNpmPackageTool,
];
