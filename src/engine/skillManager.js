// src/engine/skillManager.js
// 【木-技能库】：热插拔技能管理器
//
// 架构：木生火 —— 知识（JSON+JS技能卡 / SKILLS.md）直接转化为可执行工具（fire node）
//
// 来源优先级（同名时后者覆盖前者）：
//   1. skills/*.json + skills/*.js      —— 独立配对文件
//   2. skills/SKILLS.md 中的 JSON 块    —— MCP / Claude Code 生态兼容格式
//
// 热加载：每次 refreshSkills() 使用带时间戳的 file:// URL，绕过 ESM 模块缓存
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { readFileSync, existsSync, readdirSync, mkdirSync } from "fs";
import { join } from "path";
import { pathToFileURL } from "url";
import { ALL_TOOLS, PROJECT_ROOT } from "./toolBox.js";
import { loadAllDirectorySkills, legacyLoadFromMarkdown } from "./markdownLoader.js";
import { validateSkillConfig, normalizeSkillConfig } from "../utils/schemaValidator.js";
import { logger, EV } from "../utils/logger.js";

export const SKILLS_DIR = join(PROJECT_ROOT, "skills");

// ── JSON Schema → Zod 转换器 ────────────────────────────
function toZod(schema) {
    if (!schema || typeof schema !== "object") return z.any();

    const wrap = (zodType) =>
        schema.description ? zodType.describe(schema.description) : zodType;

    switch (schema.type) {
        case "string":  return wrap(z.string());
        case "number":  return wrap(z.number());
        case "integer": return wrap(z.number().int());
        case "boolean": return wrap(z.boolean());
        case "array": {
            const items = schema.items ? toZod(schema.items) : z.any();
            return wrap(z.array(items));
        }
        case "object": {
            if (!schema.properties) return wrap(z.record(z.any()));
            const req   = new Set(schema.required ?? []);
            const shape = {};
            for (const [key, prop] of Object.entries(schema.properties)) {
                let field = toZod(prop);
                if (!req.has(key)) field = field.optional();
                shape[key] = field;
            }
            return wrap(z.object(shape));
        }
        default: return z.any();
    }
}

// ── SkillManager 单例 ────────────────────────────────────
export class SkillManager {
    constructor() {
        this.skillsDir    = SKILLS_DIR;
        this.dynamicTools = new Map();   // name → tool 实例
        this.failedSkills = new Map();   // name → error message（审计用）
    }

    // 所有工具 = 内置工具 + 动态技能
    getAllTools() {
        return [...ALL_TOOLS, ...this.dynamicTools.values()];
    }

    // 工具名 → 实例映射（fireToolNode 快速查找用）
    getToolMap() {
        const map = {};
        for (const t of ALL_TOOLS)               map[t.name] = t;
        for (const [k, v] of this.dynamicTools)  map[k]      = v;
        return map;
    }

    // ── 扫描并重载技能库 ─────────────────────────────────
    async refreshSkills() {
        if (!existsSync(this.skillsDir)) {
            mkdirSync(this.skillsDir, { recursive: true });
        }

        this.dynamicTools.clear();
        this.failedSkills.clear();

        // 阶段一（旧格式兼容）：skills/*.json + skills/*.js 平铺配对
        const jsonFiles = readdirSync(this.skillsDir).filter((f) => f.endsWith(".json"));
        await Promise.allSettled(jsonFiles.map((f) => this.loadSkillPair(f)));

        // 阶段二（旧格式兼容）：skills/SKILLS.md 平铺 JSON 块
        const legacyMd = join(this.skillsDir, "SKILLS.md");
        if (existsSync(legacyMd)) {
            const legacySkills = await legacyLoadFromMarkdown(legacyMd, this.skillsDir);
            for (const { config, handler, isStub } of legacySkills) {
                if (isStub && this.dynamicTools.has(config.name)) continue;
                this._mountTool(config, handler, "SKILLS.md(legacy)");
            }
        }

        // 阶段三（新格式）：skills/{dir}/SKILL.md 目录型技能卡（同名时覆盖旧格式）
        const dirSkills = await loadAllDirectorySkills(this.skillsDir);
        for (const { config, handler, isStub } of dirSkills) {
            if (isStub && this.dynamicTools.has(config.name)) {
                logger.info(EV.WOOD, `技能 ${config.name}：目录型无 handler，保留已有版本`);
                continue;
            }
            this._mountTool(config, handler, "SKILL.md");
        }

        const loaded = this.dynamicTools.size;
        const failed = this.failedSkills.size;
        logger.info(EV.WOOD,
            `技能库刷新完成：共 ${loaded} 个动态技能` +
            (failed ? `，${failed} 个加载失败` : "")
        );

        return { loaded, failed, tools: [...this.dynamicTools.keys()] };
    }

    // ── 挂载单个技能（配对 / SKILLS.md 共用逻辑）──────────────
    _mountTool(config, handler, source = "JSON") {
        const schema = config.parameters ? toZod(config.parameters) : z.object({}).passthrough();

        const skillTool = tool(
            async (args) => {
                logger.info(EV.WOOD, `动态技能调用：${config.name} [来源：${source}]`);
                try {
                    const result = await handler(args);
                    return String(result ?? "(无输出)");
                } catch (e) {
                    return `【技能执行错误】${config.name}: ${e.message}`;
                }
            },
            {
                name:        config.name,
                description: config.description,
                schema,
            }
        );

        this.dynamicTools.set(config.name, skillTool);
        logger.info(EV.WOOD, `技能已挂载：${config.name} [${source}]`);
    }

    // ── 加载单个技能卡（JSON + JS 配对）────────────────────
    async loadSkillPair(jsonFile) {
        const baseName = jsonFile.replace(/\.json$/, "");
        const jsonPath = join(this.skillsDir, jsonFile);
        const jsPath   = join(this.skillsDir, `${baseName}.js`);

        // 解析并验证元数据
        let raw;
        try {
            raw = JSON.parse(readFileSync(jsonPath, "utf-8"));
        } catch (e) {
            this._fail(baseName, `JSON 解析失败：${e.message}`);
            return;
        }

        const { valid, errors } = validateSkillConfig(raw);
        if (!valid) {
            this._fail(baseName, `Schema 不合规：${errors.join("；")}`);
            return;
        }
        const meta = normalizeSkillConfig(raw);

        if (!existsSync(jsPath)) {
            this._fail(baseName, `找不到处理文件：${jsPath}`);
            return;
        }

        // 带时间戳的 file:// URL，绕过 ESM 模块缓存（热加载核心）
        const fileUrl = pathToFileURL(jsPath);
        fileUrl.searchParams.set("t", Date.now());

        let handler;
        try {
            const mod = await import(fileUrl.href);
            handler   = mod.handler ?? mod.default;
            if (typeof handler !== "function") throw new Error("未导出 handler 函数");
        } catch (e) {
            this._fail(baseName, `模块加载失败：${e.message}`);
            return;
        }

        this._mountTool(meta, handler, "JSON");
    }

    _fail(name, reason) {
        this.failedSkills.set(name, reason);
        logger.warn(EV.METAL, `[金-审计] 技能 ${name} 加载失败：${reason}`);
    }

    // 状态摘要（供 :skills 指令使用）
    status() {
        return {
            builtin:  ALL_TOOLS.map((t) => t.name),
            dynamic:  [...this.dynamicTools.keys()],
            failed:   Object.fromEntries(this.failedSkills),
            total:    ALL_TOOLS.length + this.dynamicTools.size,
        };
    }
}

// 全局单例：wuxingGraph 和 main 共享同一个实例
export const skillManager = new SkillManager();
