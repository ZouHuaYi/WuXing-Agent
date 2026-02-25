// src/engine/dream.js
// 【金-升华】：梦境合并模块 —— 记忆聚类与逻辑折叠
//
// 认知科学原型：睡眠中的记忆巩固（Memory Consolidation）
// 系统闲置时，主动将碎片化因果律聚类，合成更高阶的"道"
// 效果：消除过拟合、降低噪音、形成"通用价值观"级别的核心准则
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { ChatOpenAI } from "@langchain/openai";

const llm = new ChatOpenAI({ modelName: "gpt-4-turbo", temperature: 0.3 });

const CLUSTER_PROMPT = `你是一个高阶逻辑合成器（梦境整合引擎）。
以下是Agent积累的若干因果准则。请执行"逻辑折叠"：

1. 分析哪些准则指向同一底层规律（语义聚类）
2. 对每个语义群组，尝试合成一条更通用、更深刻的高阶准则
3. 对于彼此独立、无法合并的准则，保留原样

返回严格的JSON数组（格式与输入相同），其中合并的条目用 merged:true 标注：
[{"task":"综合场景描述","result":"高阶准则","merged":true},{"task":"原任务","result":"原准则","merged":false}]

只返回JSON数组，不要任何解释。`;

const PAIR_PROMPT = `你是一个逻辑合成器。判断以下两条因果准则是否指向同一底层逻辑。
如果是，请合成一条更通用的高阶准则（不超过60字）。
如果不是，只回复【无法合并】。

准则 A: {A}
准则 B: {B}

只返回合成结果或【无法合并】，不要其他文字。`;

export class DreamModule {
    constructor(wisdomMemory) {
        this.memory = wisdomMemory;
    }

    /**
     * 开启梦境整合：对经验库执行语义聚类 + 逻辑折叠
     * @param {number} minDocs 触发梦境所需最少条目数
     */
    async startDreaming(minDocs = 4) {
        const allDocs = this.memory.getAllDocs();

        if (allDocs.length < minDocs) {
            console.log(`[梦境] 经验积累不足 ${minDocs} 条，进入浅眠...`);
            return;
        }

        console.log(`\n[梦境] 进入深度自省模式，整合 ${allDocs.length} 条因果律...`);

        // 当条目较少时（<8条），逐对比对；较多时整批交给 LLM 聚类
        if (allDocs.length <= 8) {
            await this._pairwiseMerge(allDocs);
        } else {
            await this._batchCluster(allDocs);
        }
    }

    // 小规模：逐对尝试合并（精准但调用次数多）
    async _pairwiseMerge(docs) {
        const used = new Set();
        const result = [];
        let mergeCount = 0;

        for (let i = 0; i < docs.length; i++) {
            if (used.has(i)) continue;

            let merged = false;
            for (let j = i + 1; j < docs.length; j++) {
                if (used.has(j)) continue;

                const prompt = PAIR_PROMPT
                    .replace("{A}", docs[i].result)
                    .replace("{B}", docs[j].result);

                const res = await llm.invoke([
                    new SystemMessage("你是一个逻辑合成器，负责检测两条因果准则的共同底层规律。"),
                    new HumanMessage(prompt),
                ]);

                const synthesis = res.content.trim();
                if (synthesis !== "【无法合并】") {
                    console.log(`[梦境] 折叠成功：\n  A: "${docs[i].result}"\n  B: "${docs[j].result}"\n  => "${synthesis}"`);
                    result.push({ task: "合并场景", result: synthesis, createdAt: Date.now(), confidence: 1.0 });
                    used.add(i);
                    used.add(j);
                    mergeCount++;
                    merged = true;
                    break;
                }
            }

            if (!merged) {
                result.push(docs[i]);
            }
        }

        if (mergeCount > 0) {
            console.log(`[梦境] 折叠完成：${mergeCount} 次合并，经验库从 ${docs.length} 条精简为 ${result.length} 条`);
            await this.memory.replaceAll(result);
        } else {
            console.log("[梦境] 所有准则相互独立，无法折叠，保持现状。");
        }
    }

    // 大规模：整批交给 LLM 聚类（效率高但需要模型能力强）
    async _batchCluster(docs) {
        const docList = docs
            .map((d, i) => `${i + 1}. 任务: ${d.task}\n   准则: ${d.result}`)
            .join("\n\n");

        try {
            const res = await llm.invoke([
                new SystemMessage(CLUSTER_PROMPT),
                new HumanMessage(docList),
            ]);

            const clustered = JSON.parse(res.content.trim());
            const mergedCount = clustered.filter((d) => d.merged).length;
            const finalDocs = clustered.map(({ task, result }) => ({
                task,
                result,
                createdAt: Date.now(),
                confidence: 1.0,
            }));

            if (finalDocs.length < docs.length) {
                console.log(
                    `[梦境] 聚类折叠完成：${mergedCount} 个合并群组，` +
                    `经验库从 ${docs.length} 条净化为 ${finalDocs.length} 条`
                );
                await this.memory.replaceAll(finalDocs);
            } else {
                console.log("[梦境] 未发现可折叠的逻辑群组，经验库保持当前形态。");
            }
        } catch (e) {
            console.warn("[梦境] 聚类解析失败:", e.message);
        }
    }
}
