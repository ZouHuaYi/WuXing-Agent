// src/engine/entropyReducer.js
// 【金克木】：熵减调度器 —— 肃杀冗余，保持经验库的纯净度
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { ChatOpenAI } from "@langchain/openai";

const llm = new ChatOpenAI({ modelName: "gpt-4-turbo", temperature: 0 });

const PRUNE_PROMPT = `你是一位严苛的知识管理者（金的肃杀之性）。
以下是Agent积累的因果准则列表，请执行三项操作：

1. 合并语义高度相似的条目（保留更通用的表述，task取其一）
2. 删除相互矛盾的条目（保留逻辑更严密的那条）  
3. 删除明显低质量、过于笼统或无实际指导意义的条目

返回精简后的JSON数组（格式与输入完全相同）：[{"task":"...","result":"..."}]
如果所有条目均高质量无需修剪，也返回原数组。
只返回JSON数组，不要任何解释文字。`;

/**
 * 对经验库执行熵减修剪
 * @param {import('./vectorStore.js').WisdomMemory} wisdomMemory
 */
export async function prune(wisdomMemory) {
    const allDocs = wisdomMemory.getAllDocs();

    if (allDocs.length < 3) {
        console.log("[金-熵减] 经验库条目不足3条，跳过修剪。");
        return;
    }

    console.log(`\n[金-熵减] 肃杀启动，审查 ${allDocs.length} 条因果律...`);

    const docList = allDocs
        .map((d, i) => `${i + 1}. 任务场景: ${d.task}\n   因果准则: ${d.result}`)
        .join("\n\n");

    try {
        const res = await llm.invoke([
            new SystemMessage(PRUNE_PROMPT),
            new HumanMessage(docList),
        ]);

        const pruned = JSON.parse(res.content.trim());
        const removed = allDocs.length - pruned.length;

        if (removed > 0) {
            console.log(`[金-熵减] 修剪完成：淘汰 ${removed} 条冗余规律，经验库净化为 ${pruned.length} 条。`);
            await wisdomMemory.replaceAll(pruned);
        } else {
            console.log("[金-熵减] 经验库纯净度良好，无需修剪。");
        }
    } catch (e) {
        console.warn("[金-熵减] 修剪解析失败，本轮跳过:", e.message);
    }
}
