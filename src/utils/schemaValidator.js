// src/utils/schemaValidator.js
// 【金-审计】：技能卡 Schema 验证器
//
// 兼容两种键名：
//   parameters  —— 本地约定（JSON Schema 标准）
//   input_schema —— MCP / Claude Code 约定
//
// 验证规则：
//   name        必须是有效标识符（字母/数字/下划线，不以数字开头）
//   description 非空，≥ 5 字符
//   parameters  如果存在，type 必须为 "object"，properties 必须为对象

const IDENTIFIER_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

/**
 * 验证单个技能配置对象
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function validateSkillConfig(config) {
    const errors = [];

    // ── name ─────────────────────────────────────────────────
    if (!config.name || typeof config.name !== "string") {
        errors.push("name 字段缺失或非字符串");
    } else if (!IDENTIFIER_RE.test(config.name)) {
        errors.push(`name "${config.name}" 不是有效标识符（只允许字母/数字/下划线，不以数字开头）`);
    }

    // ── description ──────────────────────────────────────────
    if (!config.description || typeof config.description !== "string") {
        errors.push("description 字段缺失或非字符串");
    } else if (config.description.trim().length < 5) {
        errors.push("description 太短（至少 5 字符）");
    }

    // ── parameters / input_schema ─────────────────────────────
    const schema = config.parameters ?? config.input_schema;
    if (schema !== undefined && schema !== null) {
        if (typeof schema !== "object" || Array.isArray(schema)) {
            errors.push("parameters / input_schema 必须是对象");
        } else {
            if (schema.type && schema.type !== "object") {
                errors.push(`parameters.type 必须是 "object"，当前是 "${schema.type}"`);
            }
            if (schema.properties !== undefined && typeof schema.properties !== "object") {
                errors.push("parameters.properties 必须是对象");
            }
            if (schema.required !== undefined && !Array.isArray(schema.required)) {
                errors.push("parameters.required 必须是数组");
            }
        }
    }

    return { valid: errors.length === 0, errors };
}

/**
 * 规范化：将 input_schema 统一映射到 parameters
 * 同时补全缺省值，确保后续处理不需要判断 null
 */
export function normalizeSkillConfig(config) {
    const normalized = { ...config };

    // input_schema → parameters（优先保留 parameters）
    if (!normalized.parameters && normalized.input_schema) {
        normalized.parameters = normalized.input_schema;
    }
    delete normalized.input_schema;

    // 补全空 parameters
    if (!normalized.parameters) {
        normalized.parameters = { type: "object", properties: {}, required: [] };
    }

    return normalized;
}
