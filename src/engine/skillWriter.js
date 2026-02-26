// src/engine/skillWriter.js
// 【木-自生长】：自写技能系统
//
// 当反思节点（金）提炼出的因果律得分超过 skillThreshold 时，
// 主动判断是否值得封装为目录型技能卡（skills/{name}/SKILL.md + schema.json + scripts/index.js）。
//
// 这实现了"五行自生长"：
//   金（提炼） → 分数足够高 → 木（种下新技能） → 火（下次直接使用）
//
// LLM 被要求输出结构化 JSON，包含：
//   - should_create: boolean
//   - skill_name:    snake_case 标识符
//   - description:   触发场景描述
//   - parameters:    JSON Schema
//   - handler_code:  完整的 ESM handler 函数体（可执行的 Node.js 代码）
import { ChatOpenAI }      from "@langchain/openai";
import { SystemMessage, HumanMessage } from "@langchain/core/messages";
import { mkdir, writeFile, existsSync } from "fs";
import { promisify }       from "util";
import { join }            from "path";
import { PROJECT_ROOT }    from "./toolBox.js";
import { logger, EV }      from "../utils/logger.js";
import cfg                 from "../../config/wuxing.json" with { type: "json" };

const mkdirAsync     = promisify(mkdir);
const writeFileAsync = promisify(writeFile);

const SKILLS_DIR = join(PROJECT_ROOT, "skills");

const llm = new ChatOpenAI({
    modelName:   cfg.models.reasoning,
    temperature: 0.2,   // 低温保证代码输出稳定
});

// 评估提示词：让 LLM 决定是否值得封装、并生成完整技能定义
const EVALUATE_PROMPT = `
你是技能封装专家。判断以下"任务-解法"对是否值得封装为一个可复用的工具函数，并输出严格的 JSON。

判断标准（需同时满足）：
1. 该解法包含明确可参数化的步骤（有输入 → 有输出）
2. 相同类型的任务在未来可能反复出现
3. 核心逻辑可以用 Node.js（无外部 API Key）实现

输出格式（不要任何 markdown 包裹，直接输出 JSON）：
{
  "should_create": true 或 false,
  "reason": "一句话说明原因",
  "skill_name": "snake_case 标识符，如 calculate_fibonacci，不超过 40 字符",
  "description": "第三人称描述，包含 WHAT 和 WHEN，不超过 120 字符",
  "parameters": {
    "type": "object",
    "properties": {
      "param1": { "type": "string", "description": "参数说明" }
    },
    "required": ["param1"]
  },
  "handler_code": "完整的 ES Module handler 函数，格式：export async function handler(args) { ... }"
}

如果 should_create 为 false，其余字段可以为 null。
`.trim();

export class SkillWriter {
    constructor(skillManager) {
        this.skillManager = skillManager;  // 写完后触发热加载
        this.recentWritten = new Set();    // 防止重复写入（进程内去重）
    }

    /**
     * 主入口：根据 task + solution + score 决定是否封装为技能
     * @param {string}  task       原始用户任务
     * @param {string}  solution   Agent 的解决方案（最终回答）
     * @param {number}  score      反思节点的质量分（0-100）
     * @returns {Promise<{created: boolean, skillName?: string}>}
     */
    async tryWrite(task, solution, score) {
        const threshold = cfg.reflection.skillThreshold ?? 85;
        if (score < threshold) {
            return { created: false };
        }

        // 防止相同任务在同次运行中重复写入
        const key = `${task.slice(0, 80)}`;
        if (this.recentWritten.has(key)) {
            return { created: false };
        }

        logger.info(EV.WOOD, `[自生长] 分数 ${score} ≥ ${threshold}，评估是否封装为技能...`);

        try {
            const def = await this._evaluate(task, solution);
            if (!def.should_create) {
                logger.info(EV.WOOD, `[自生长] 判定不值得封装：${def.reason}`);
                return { created: false };
            }

            if (!this._validateName(def.skill_name)) {
                logger.warn(EV.METAL, `[金-审计] 自写技能名称不合规：${def.skill_name}`);
                return { created: false };
            }

            // 已存在同名技能 → 跳过（不覆盖人工写的）
            const targetDir = join(SKILLS_DIR, def.skill_name);
            if (existsSync(targetDir)) {
                logger.info(EV.WOOD, `[自生长] 技能 ${def.skill_name} 已存在，跳过。`);
                return { created: false };
            }

            await this._writeSkillDir(def);
            this.recentWritten.add(key);

            // 热加载：让新技能立即可用
            if (this.skillManager) {
                await this.skillManager.refreshSkills();
            }

            logger.evolution(EV.WOOD,
                `[自生长] 新技能已种下：skills/${def.skill_name}/  （${def.description}）`
            );
            return { created: true, skillName: def.skill_name };

        } catch (e) {
            logger.warn(EV.WOOD, `[自生长] 技能封装失败：${e.message}`);
            return { created: false };
        }
    }

    // ── 私有方法 ──────────────────────────────────────────────

    async _evaluate(task, solution) {
        const res = await llm.invoke([
            new SystemMessage(EVALUATE_PROMPT),
            new HumanMessage(
                `任务：${task}\n\n解法：${solution.slice(0, 800)}`
            ),
        ]);

        return JSON.parse(res.content.trim());
    }

    _validateName(name) {
        return typeof name === "string" && /^[a-z][a-z0-9_]{1,39}$/.test(name);
    }

    async _writeSkillDir(def) {
        const dirPath     = join(SKILLS_DIR, def.skill_name);
        const scriptsPath = join(dirPath, "scripts");

        await mkdirAsync(scriptsPath, { recursive: true });

        // SKILL.md
        const skillMd = [
            `---`,
            `name: ${def.skill_name}`,
            `description: ${def.description}`,
            `---`,
            ``,
            `# ${def.skill_name}`,
            ``,
            `> 由 WuXing-Agent 自动生成（自生长）`,
            ``,
            `## 原始任务`,
            ``,
            `> ${def._source_task ?? "(自动提炼)"}`,
        ].join("\n");

        // schema.json
        const schema = JSON.stringify(
            def.parameters ?? { type: "object", properties: {}, required: [] },
            null, 2
        );

        // scripts/index.js — 剔除可能的 markdown 围栏
        const handlerCode = (def.handler_code ?? "export async function handler(args) { return '(尚未实现)'; }")
            .replace(/^```(?:js|javascript)?\n?/, "")
            .replace(/\n?```$/, "")
            .trim();

        await writeFileAsync(join(dirPath, "SKILL.md"),          skillMd,     "utf-8");
        await writeFileAsync(join(dirPath, "schema.json"),        schema,      "utf-8");
        await writeFileAsync(join(scriptsPath, "index.js"),       handlerCode, "utf-8");
    }
}
