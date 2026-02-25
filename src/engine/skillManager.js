// src/engine/skillManager.js
// 【木-技能库】：热插拔技能管理器
//
// 来源优先级（同名时后者覆盖前者）：
//   1. skills/*.json + skills/*.js      —— 独立配对文件（兼容旧格式）
//   2. skills/SKILLS.md 中的 JSON 块    —— 平铺 Markdown（兼容旧格式）
//   3. skills/{dir}/SKILL.md            —— 目录型技能卡（推荐新格式）
//   4. config/mcp.json 中的 MCP 服务    —— 外部 stdio/SSE 工具服务
//
// 热加载：:reload 同时刷新本地技能 + MCP 工具
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { readFileSync, existsSync, readdirSync, mkdirSync } from "fs";
import { join } from "path";
import { pathToFileURL } from "url";
import { ALL_TOOLS, PROJECT_ROOT } from "./toolBox.js";
import { loadAllDirectorySkills, legacyLoadFromMarkdown } from "./markdownLoader.js";
import { validateSkillConfig, normalizeSkillConfig } from "../utils/schemaValidator.js";
import { mcpPool }          from "./mcpClient.js";
import { logger, EV }       from "../utils/logger.js";
import agentsCfg            from "../../config/agents.json" with { type: "json" };

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
        this.mcpTools     = new Map();   // name → tool 实例（MCP 来源单独记录）
        this._toolConfigs = new Map();   // name → 原始 config（供角色过滤使用）
    }

    // 所有工具 = 内置工具 + 动态技能 + MCP 工具
    getAllTools() {
        return [...ALL_TOOLS, ...this.dynamicTools.values(), ...this.mcpTools.values()];
    }

    // 工具名 → 实例映射（fireToolNode 快速查找用）
    getToolMap() {
        const map = {};
        for (const t of ALL_TOOLS)              map[t.name] = t;
        for (const [k, v] of this.dynamicTools) map[k]      = v;
        for (const [k, v] of this.mcpTools)     map[k]      = v;
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

        // 阶段四（MCP 服务）：从 config/mcp.json 已连接的服务中获取工具
        this.mcpTools.clear();
        const mcpPairs = mcpPool.getAllToolPairs();
        for (const { config, handler, source } of mcpPairs) {
            this._mountMcpTool(config, handler, source);
        }

        const loaded = this.dynamicTools.size + this.mcpTools.size;
        const failed = this.failedSkills.size;
        logger.info(EV.WOOD,
            `技能库刷新完成：本地 ${this.dynamicTools.size} 个，MCP ${this.mcpTools.size} 个` +
            (failed ? `，${failed} 个加载失败` : "")
        );

        return {
            loaded,
            failed,
            tools:    [...this.dynamicTools.keys()],
            mcpTools: [...this.mcpTools.keys()],
        };
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
        this._toolConfigs.set(config.name, config);
        logger.info(EV.WOOD, `技能已挂载：${config.name} [${source}]${config.assigned_to ? ` (→${config.assigned_to})` : ""}`);
    }

    // ── 挂载 MCP 工具（独立 Map，便于 status 区分来源）────────
    _mountMcpTool(config, handler, source) {
        const schema = config.parameters ? toZod(config.parameters) : z.object({}).passthrough();

        const mcpTool = tool(
            async (args) => {
                logger.info(EV.WATER, `MCP 工具调用：${config.name} [${source}]`);
                try {
                    return String(await handler(args) ?? "(无输出)");
                } catch (e) {
                    return `【MCP 调用错误】${config.name}: ${e.message}`;
                }
            },
            { name: config.name, description: config.description, schema }
        );

        this.mcpTools.set(config.name, mcpTool);
        logger.info(EV.WATER, `MCP 工具已挂载：${config.name} [${source}]`);
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

    // ── 按角色获取工具子集 ──────────────────────────────────
    // 规则（优先级依次降低）：
    //   1. 技能卡有 assigned_to 字段 → 只分配给该角色
    //   2. agents.json tool_category_map → 按类别分配内置工具
    //   3. agents.json mcp_access 列表 → 按服务名过滤 MCP 工具
    getToolsForRole(role) {
        const roleCfg   = agentsCfg.agents[role];
        const catMap    = agentsCfg.tool_category_map ?? {};
        const allowedNames = new Set();

        if (roleCfg) {
            // 内置工具：按分类展开
            for (const cat of (roleCfg.tool_categories ?? [])) {
                for (const name of (catMap[cat] ?? [])) allowedNames.add(name);
            }
        }

        // 内置工具过滤
        // tool_categories 不存在（null/undefined）→ 给全部；
        // tool_categories 为空数组 [] → 不给任何内置工具（该角色无直接工具权限）
        const cats = roleCfg?.tool_categories;
        const builtinFiltered = cats === undefined || cats === null
            ? ALL_TOOLS
            : cats.length > 0
                ? ALL_TOOLS.filter((t) => allowedNames.has(t.name))
                : [];   // 空数组 = 明确限制为零

        // 动态技能：检查 assigned_to 字段
        const dynamicFiltered = [...this.dynamicTools.values()].filter((t) => {
            const cfg = this._getToolConfig(t.name);
            if (!cfg?.assigned_to) return true;   // 未指定角色 → 所有角色可用
            const roles = Array.isArray(cfg.assigned_to)
                ? cfg.assigned_to
                : [cfg.assigned_to];
            return roles.includes(role);
        });

        // MCP 工具：按 mcp_access 列表过滤
        const mcpAccess = roleCfg?.mcp_access ?? [];
        const mcpFiltered = mcpAccess.length === 0
            ? []   // 未配置 mcp_access → 该角色不访问 MCP
            : [...this.mcpTools.entries()]
                .filter(([name]) => mcpAccess.some((srvName) => name.startsWith(`${srvName}__`)))
                .map(([, t]) => t);

        return [...builtinFiltered, ...dynamicFiltered, ...mcpFiltered];
    }

    // 内部：通过工具名反查原始 config（用于 assigned_to 检查）
    _getToolConfig(toolName) {
        return this._toolConfigs?.get(toolName) ?? null;
    }

    // 状态摘要（供 :skills / :list 指令使用）
    status() {
        return {
            builtin:   ALL_TOOLS.map((t) => t.name),
            dynamic:   [...this.dynamicTools.keys()],
            mcp:       [...this.mcpTools.keys()],
            mcpStatus: mcpPool.getStatus(),
            failed:    Object.fromEntries(this.failedSkills),
            total:     ALL_TOOLS.length + this.dynamicTools.size + this.mcpTools.size,
        };
    }
}

// 全局单例：wuxingGraph 和 main 共享同一个实例
export const skillManager = new SkillManager();
