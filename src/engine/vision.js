// src/engine/vision.js
// 【水-视觉】：多模态感知模块 —— "取象比类"
//
// 传统哲学原型："观象系辞" —— 圣人仰观天文，俯察地理，近取诸身，远取诸物
// 将图像的"象"转化为 Agent 可推演的"理"，打通视觉与因果逻辑的通道
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { ChatOpenAI } from "@langchain/openai";
import { readFile } from "fs/promises";
import { existsSync } from "fs";

// gpt-4o 具备视觉能力，是"取象"的最佳载体
const visionModel = new ChatOpenAI({ modelName: "gpt-4o", maxTokens: 800 });

const OBSERVE_PROMPT = `你是一位具备"取象比类"能力的观察者。
请从以下三个维度解析图像：

1. 象（表象）：图像中有什么？结构、布局、关键元素是什么？
2. 数（数量关系）：节点数量、连接密度、层级深度等量化特征
3. 理（因果推断）：这个系统/格局处于什么状态？潜在的风险或机遇是什么？

请用3-5句话输出你的观察，每个维度一句，最后给出一个"行动建议"。`;

export class VisionModule {
    /**
     * 【取象】：将图片转化为结构化语义描述
     * @param {string} imagePath 本地图片路径（支持 jpg/png/webp）
     * @returns {Promise<string>} 语义描述（可直接投入五行工作流）
     */
    async captureImageLogic(imagePath) {
        if (!existsSync(imagePath)) {
            throw new Error(`图片文件不存在: ${imagePath}`);
        }

        console.log(`\n[水-视觉] 正在取象：${imagePath}`);

        const imageBuffer = await readFile(imagePath);
        const base64 = imageBuffer.toString("base64");
        const mimeType = imagePath.toLowerCase().endsWith(".png") ? "image/png" : "image/jpeg";

        const response = await visionModel.invoke([
            new SystemMessage(OBSERVE_PROMPT),
            new HumanMessage({
                content: [
                    { type: "text", text: "请观察并解析这张图像的象、数、理：" },
                    {
                        type: "image_url",
                        image_url: { url: `data:${mimeType};base64,${base64}` },
                    },
                ],
            }),
        ]);

        console.log("[水-视觉] 取象完成，已转化为语义流");
        return response.content;
    }

    /**
     * 批量取象：处理多张图片，返回综合的场景描述
     * @param {string[]} imagePaths
     * @returns {Promise<string>}
     */
    async captureMultiple(imagePaths) {
        const descriptions = [];
        for (const p of imagePaths) {
            try {
                const desc = await this.captureImageLogic(p);
                descriptions.push(`[图像 ${p}]\n${desc}`);
            } catch (e) {
                console.warn(`[水-视觉] 跳过 ${p}: ${e.message}`);
            }
        }
        return descriptions.join("\n\n---\n\n");
    }
}
