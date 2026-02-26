// src/engine/markdownLoader.js
// 【木-感知】：目录型技能卡加载器
//
// 标准目录结构（每个技能一个独立文件夹）：
//
//   skills/
//   └── {skill-dir}/
//       ├── SKILL.md          必须 — YAML frontmatter 定义 name / description
//       ├── schema.json       可选 — 工具入参 JSON Schema
//       └── scripts/
//           ├── index.py      首选 — Python handler（通过 stdin/stdout JSON 通信）
//           └── index.js      备选 — ESM handler（export async function handler(args){}）
//
// Python handler 约定：
//   - 通过 stdin 接收 JSON 参数对象
//   - 通过 stdout 输出结果字符串
//   - 非零退出码 = 执行失败
//
// handler 优先级（Python 优先）：
//   1. scripts/index.py  ← 优先（依赖用 pip 管理，更稳定）
//   2. scripts/index.js  ← 备选（纯计算类 / 已有 Node.js 实现）
//   3. Stub              ← 兜底
//
// 兼容旧格式（平铺型）：SKILLS.md 中的 JSON 块，见 legacyLoadFromMarkdown()
import { readFileSync, existsSync, readdirSync, statSync } from "fs";
import { join } from "path";
import { pathToFileURL } from "url";
import { execFile } from "child_process";
import { promisify } from "util";
import { validateSkillConfig, normalizeSkillConfig } from "../utils/schemaValidator.js";
import { logger, EV } from "../utils/logger.js";
import cfg from "../../config/wuxing.json" with { type: "json" };

const execFileAsync = promisify(execFile);
const PYTHON_CMD    = cfg.tools?.pythonCmd ?? "python";
const SKILL_TIMEOUT = (cfg.tools?.executionTimeoutMs ?? 15000);

// ── Python 子进程 handler 工厂 ─────────────────────────────
// 将 Python 脚本包装为与 JS handler 相同签名的 async 函数
// 通信协议：args → JSON → stdin；stdout → 结果字符串
function createPythonHandler(scriptPath, skillName) {
    return async (args) => {
        const input = JSON.stringify(args ?? {});
        try {
            const { stdout, stderr } = await execFileAsync(
                PYTHON_CMD,
                [scriptPath],
                {
                    input,
                    timeout:   SKILL_TIMEOUT,
                    env:       { ...process.env },
                    maxBuffer: 256 * 1024,
                }
            );
            const out = (stdout ?? "").trim();
            const err = (stderr ?? "").trim();
            if (out) return out;
            if (err) return `[stderr] ${err}`;
            return "(无输出)";
        } catch (e) {
            const msg    = e.killed ? `执行超时（>${SKILL_TIMEOUT}ms）` : e.message;
            const stderr = (e.stderr ?? "").slice(0, 400);
            return `【技能 ${skillName} 执行失败】${msg}${stderr ? `\n${stderr}` : ""}`;
        }
    };
}

// ── YAML Frontmatter 解析（仅支持简单字符串值，满足 name/description 需求）─
const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---/;

function parseFrontmatter(content) {
    const match = content.match(FRONTMATTER_RE);
    if (!match) return { meta: {}, body: content.trim() };

    const meta = {};
    for (const line of match[1].split("\n")) {
        const kv = line.match(/^([\w-]+):\s*(.+)$/);
        if (kv) meta[kv[1].trim()] = kv[2].trim().replace(/^["']|["']$/g, "");
    }

    return { meta, body: content.slice(match[0].length).trim() };
}

// ── 加载单个目录型技能 ──────────────────────────────────────────────────────
/**
 * @typedef {{ config: object, handler: Function, isStub: boolean }} SkillEntry
 * @param {string} dirPath  技能根目录（如 skills/get-datetime/）
 * @returns {Promise<SkillEntry|null>}
 */
export async function loadDirectorySkill(dirPath) {
    const skillMdPath = join(dirPath, "SKILL.md");
    if (!existsSync(skillMdPath)) return null;

    // ── 1. 解析 SKILL.md ───────────────────────────────────────
    const raw  = readFileSync(skillMdPath, "utf-8");
    const { meta } = parseFrontmatter(raw);

    // ── 2. 合并 schema.json（可选）────────────────────────────
    const schemaPath = join(dirPath, "schema.json");
    let parameters   = undefined;
    if (existsSync(schemaPath)) {
        try {
            parameters = JSON.parse(readFileSync(schemaPath, "utf-8"));
        } catch (e) {
            logger.warn(EV.METAL, `[金-审计] ${meta.name ?? dirPath} schema.json 解析失败：${e.message}`);
        }
    }

    const rawConfig = {
        name:        meta.name,
        description: meta.description,
        parameters,
        assigned_to: meta.assigned_to ?? meta["assigned-to"] ?? null,
    };

    // ── 3. Schema 验证 ────────────────────────────────────────
    const { valid, errors } = validateSkillConfig(rawConfig);
    if (!valid) {
        logger.warn(EV.METAL,
            `[金-审计] 技能目录 "${dirPath}" SKILL.md 不合规：${errors.join("；")}`
        );
        return null;
    }

    const config = normalizeSkillConfig(rawConfig);

    // ── 4. 查找 handler（Python 优先 → JS 备选 → Stub）────────
    const pyPath = join(dirPath, "scripts", "index.py");
    const jsPath = join(dirPath, "scripts", "index.js");
    let handler  = null;
    let isStub   = false;

    // 优先：Python 脚本（依赖用 pip 管理，避免 Node.js 模块路径问题）
    if (existsSync(pyPath)) {
        handler = createPythonHandler(pyPath, config.name);
        logger.info(EV.WOOD, `技能 ${config.name}：加载 scripts/index.py（Python）`);
    }

    // 备选：ESM JS handler
    if (!handler && existsSync(jsPath)) {
        try {
            const fileUrl = pathToFileURL(jsPath);
            fileUrl.searchParams.set("t", Date.now());
            const mod = await import(fileUrl.href);
            const fn  = mod.handler ?? mod.default;
            if (typeof fn !== "function") throw new Error("未导出 handler 函数");
            handler = fn;
            logger.info(EV.WOOD, `技能 ${config.name}：加载 scripts/index.js（JS）`);
        } catch (e) {
            logger.warn(EV.METAL, `[金-审计] 技能 ${config.name} JS handler 加载失败：${e.message}`);
        }
    }

    // 兜底：Stub
    if (!handler) {
        isStub  = true;
        handler = async () =>
            `【技能 "${config.name}" 尚未实现】` +
            `请在 ${dirPath}/scripts/ 下创建 index.py（推荐）或 index.js。`;
        logger.info(EV.WOOD, `技能 ${config.name}：Stub handler（待实现）`);
    }

    return { config, handler, isStub };
}

// ── 扫描技能目录，加载所有目录型技能 ────────────────────────────────────────
/**
 * @param {string} skillsDir  技能根目录（如 project_root/skills/）
 * @returns {Promise<SkillEntry[]>}
 */
export async function loadAllDirectorySkills(skillsDir) {
    if (!existsSync(skillsDir)) return [];

    const results = [];
    const entries = readdirSync(skillsDir);

    for (const entry of entries) {
        const entryPath = join(skillsDir, entry);
        // 只处理子目录（跳过平铺文件和 __开头的目录）
        if (!statSync(entryPath).isDirectory()) continue;
        if (entry.startsWith("_") || entry.startsWith(".")) continue;

        const skill = await loadDirectorySkill(entryPath);
        if (skill) results.push(skill);
    }

    logger.info(EV.WOOD, `目录型技能扫描完成：发现 ${results.length} 个有效技能`);
    return results;
}

// ── 旧格式兼容：解析平铺 SKILLS.md 中的 JSON 块 ─────────────────────────────
// （保留以支持平铺文件迁移期间的过渡使用）
const JSON_BLOCK_RE = /```json\s*\n([\s\S]*?)```/g;
const JS_BLOCK_RE   = /^([^`]|`(?!``))*```(?:js|javascript)\s*\n([\s\S]*?)```/;

/**
 * @param {string} mdPath     SKILLS.md 完整路径
 * @param {string} skillsDir  同目录 JS handler 查找路径
 * @returns {Promise<SkillEntry[]>}
 */
export async function legacyLoadFromMarkdown(mdPath, skillsDir) {
    if (!existsSync(mdPath)) return [];

    const content = readFileSync(mdPath, "utf-8");
    const results = [];
    let   match;

    while ((match = JSON_BLOCK_RE.exec(content)) !== null) {
        const jsonStr    = match[1].trim();
        const afterBlock = content.slice(match.index + match[0].length);

        let raw;
        try {
            raw = JSON.parse(jsonStr);
        } catch (e) {
            logger.warn(EV.METAL, `[金-审计] SKILLS.md JSON 解析失败：${e.message}`);
            continue;
        }

        const { valid, errors } = validateSkillConfig(raw);
        if (!valid) {
            logger.warn(EV.METAL, `[金-审计] "${raw.name ?? "(无名)"}" Schema 不合规：${errors.join("；")}`);
            continue;
        }

        const config = normalizeSkillConfig(raw);
        let handler  = null;
        let isStub   = false;

        // 内联 js 块
        const inlineMatch = JS_BLOCK_RE.exec(afterBlock);
        if (inlineMatch) {
            try {
                // eslint-disable-next-line no-new-func
                const fn = new Function(`"use strict"; ${inlineMatch[2].trim()}; return handler;`)();
                if (typeof fn !== "function") throw new Error("未定义 handler");
                handler = fn;
            } catch (e) {
                logger.warn(EV.METAL, `[金-审计] ${config.name} 内联 handler 编译失败：${e.message}`);
            }
        }

        // 平铺 {name}.js
        if (!handler) {
            const jsPath = join(skillsDir, `${config.name}.js`);
            if (existsSync(jsPath)) {
                try {
                    const fileUrl = pathToFileURL(jsPath);
                    fileUrl.searchParams.set("t", Date.now());
                    const mod = await import(fileUrl.href);
                    const fn  = mod.handler ?? mod.default;
                    if (typeof fn !== "function") throw new Error("未导出 handler");
                    handler = fn;
                } catch (e) {
                    logger.warn(EV.METAL, `[金-审计] ${config.name} 文件 handler 失败：${e.message}`);
                }
            }
        }

        if (!handler) {
            isStub  = true;
            handler = async () => `【技能 "${config.name}" 尚未实现（SKILLS.md 旧格式）】`;
        }

        results.push({ config, handler, isStub });
    }

    return results;
}
