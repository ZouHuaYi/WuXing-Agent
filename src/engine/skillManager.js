// src/engine/skillManager.js
// 【木-技能库】：热插拔技能管理器
//
// 架构：木生火 —— 知识（JSON+JS技能卡）直接转化为可执行工具（fire node）
//
// 目录约定：
//   skills/my_skill.json  —— 元数据（name / description / parameters JSON Schema）
//   skills/my_skill.js    —— 处理函数（ESM，export async function handler(args){}）
//
// 热加载：每次 refreshSkills() 使用带时间戳的 file:// URL，绕过 ESM 模块缓存
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { readFileSync, existsSync, readdirSync, mkdirSync } from "fs";
import { join } from "path";
import { pathToFileURL } from "url";
import { ALL_TOOLS, PROJECT_ROOT } from "./toolBox.js";
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

        const jsonFiles = readdirSync(this.skillsDir)
            .filter((f) => f.endsWith(".json"));

        const results = await Promise.allSettled(
            jsonFiles.map((f) => this.loadSkillPair(f))
        );

        const loaded  = this.dynamicTools.size;
        const failed  = this.failedSkills.size;

        logger.info(EV.WOOD,
            `技能库刷新：加载 ${loaded} 个动态技能` +
            (failed ? `，${failed} 个失败` : "")
        );

        return { loaded, failed, tools: [...this.dynamicTools.keys()] };
    }

    // ── 加载单个技能卡（JSON + JS 配对）────────────────────
    async loadSkillPair(jsonFile) {
        const baseName = jsonFile.replace(/\.json$/, "");
        const jsonPath = join(this.skillsDir, jsonFile);
        const jsPath   = join(this.skillsDir, `${baseName}.js`);

        // 解析元数据
        let meta;
        try {
            meta = JSON.parse(readFileSync(jsonPath, "utf-8"));
        } catch (e) {
            this._fail(baseName, `JSON 解析失败：${e.message}`);
            return;
        }

        if (!meta.name || !meta.description) {
            this._fail(baseName, "缺少必填字段：name / description");
            return;
        }

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

        // 构建 Zod schema
        const schema = meta.parameters
            ? toZod(meta.parameters)
            : z.object({}).passthrough();

        // 包装为 LangChain tool
        const skillTool = tool(
            async (args) => {
                logger.info(EV.WOOD, `动态技能调用：${meta.name}`);
                try {
                    const result = await handler(args);
                    return String(result ?? "(无输出)");
                } catch (e) {
                    return `【技能执行错误】${meta.name}: ${e.message}`;
                }
            },
            {
                name:        meta.name,
                description: meta.description,
                schema,
            }
        );

        this.dynamicTools.set(meta.name, skillTool);
        logger.info(EV.WOOD, `技能已挂载：${meta.name}`);
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
