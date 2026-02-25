// src/engine/waterSensor.js
// 【水】：环境感知模块 —— 像水一样渗透进任务边界，解析情绪与时序上下文
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { ChatOpenAI } from "@langchain/openai";
import cfg from "../../config/wuxing.json" with { type: "json" };

const llm = new ChatOpenAI({
    modelName: cfg.models.sensing,
    temperature: cfg.temperature.sensing,
});

const SENSE_PROMPT = `你是一个情绪与语境分析器。分析以下用户输入，返回严格的JSON对象（不要加任何markdown代码块包裹）：

{
  "tone": "calm|urgent|anxious|rational|frustrated",
  "urgency": 0.0到1.0之间的数字（0=完全不紧迫，1=极度紧迫）,
  "temporalHints": "对时间背景的简短描述，或null"
}

只返回JSON，不要任何解释文字。`;

/**
 * 感知输入的环境上下文
 * @param {string} input 用户输入文本
 * @returns {{ tone: string, urgency: number, temporalHints: string|null }}
 */
export async function sense(input) {
    try {
        const res = await llm.invoke([
            new SystemMessage(SENSE_PROMPT),
            new HumanMessage(input),
        ]);
        return JSON.parse(res.content.trim());
    } catch {
        // 解析失败时返回中性默认值，不让感知层阻断主流程
        return { tone: "calm", urgency: 0.3, temporalHints: null };
    }
}
