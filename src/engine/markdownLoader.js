// src/engine/markdownLoader.js
// 【木-感知】：SKILLS.md 解析器
//
// 文件格式（兼容 MCP / Claude Code 生态）：
//
//   ```json
//   { "name": "tool_name", "description": "...", "parameters": {...} }
//   ```
//
// handler 优先级：
//   1. 紧跟 JSON 块的 ```js 块 —— 内联逻辑（适合简单场景）
//   2. skills/{name}.js            —— 独立文件（推荐）
//   3. Stub                        —— 仅注册 Schema，isStub=true
import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { pathToFileURL } from "url";
import { validateSkillConfig, normalizeSkillConfig } from "../utils/schemaValidator.js";
import { logger, EV } from "../utils/logger.js";

// 提取 ```json ... ``` 块
const JSON_BLOCK_RE = /```json\s*\n([\s\S]*?)```/g;
// 紧跟的 ```js / ```javascript 块（中间不能有其他 ``` ）
const JS_BLOCK_RE   = /^([^`]|`(?!``))*```(?:js|javascript)\s*\n([\s\S]*?)```/;

/**
 * @typedef {{ config: object, handler: Function, isStub: boolean }} SkillEntry
 * @param {string} mdPath
 * @param {string} skillsDir
 * @returns {Promise<SkillEntry[]>}
 */
export async function parseSkillsMarkdown(mdPath, skillsDir) {
    if (!existsSync(mdPath)) return [];

    const content = readFileSync(mdPath, "utf-8");
    const results = [];
    let   match;

    while ((match = JSON_BLOCK_RE.exec(content)) !== null) {
        const jsonStr    = match[1].trim();
        const afterBlock = content.slice(match.index + match[0].length);

        // ── 1. 解析 JSON ──────────────────────────────────────
        let raw;
        try {
            raw = JSON.parse(jsonStr);
        } catch (e) {
            logger.warn(EV.METAL, `[金-审计] SKILLS.md JSON 解析失败：${e.message}`);
            continue;
        }

        // ── 2. Schema 验证 ────────────────────────────────────
        const { valid, errors } = validateSkillConfig(raw);
        if (!valid) {
            logger.warn(EV.METAL,
                `[金-审计] 技能 "${raw.name ?? "(无名)"}" Schema 不合规：${errors.join("；")}`
            );
            continue;
        }

        const config = normalizeSkillConfig(raw);

        // ── 3. 查找 handler ───────────────────────────────────
        let handler  = null;
        let isStub   = false;

        // 3a. 内联 ```js 块（紧跟 JSON 块，中间无其他 ``` 段）
        const inlineMatch = JS_BLOCK_RE.exec(afterBlock);
        if (inlineMatch) {
            const code = inlineMatch[2].trim();
            try {
                // eslint-disable-next-line no-new-func
                const fn = new Function(`"use strict"; ${code}; return handler;`)();
                if (typeof fn !== "function") throw new Error("未定义 handler 函数");
                handler = fn;
                logger.info(EV.WOOD, `技能 ${config.name}：内联 handler`);
            } catch (e) {
                logger.warn(EV.METAL, `[金-审计] ${config.name} 内联 handler 编译失败：${e.message}`);
            }
        }

        // 3b. 独立 JS 文件 skills/{name}.js
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
                    logger.info(EV.WOOD, `技能 ${config.name}：文件 handler (${config.name}.js)`);
                } catch (e) {
                    logger.warn(EV.METAL, `[金-审计] ${config.name} 文件 handler 失败：${e.message}`);
                }
            }
        }

        // 3c. Stub
        if (!handler) {
            isStub  = true;
            handler = async () =>
                `【技能 "${config.name}" 尚未实现】请在 skills/${config.name}.js 中添加 handler。`;
            logger.info(EV.WOOD, `技能 ${config.name}：Stub handler（待实现）`);
        }

        results.push({ config, handler, isStub });
    }

    logger.info(EV.WOOD, `SKILLS.md 解析完成：${results.length} 个技能定义`);
    return results;
}
