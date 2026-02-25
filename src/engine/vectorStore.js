// src/engine/vectorStore.js
// 【木】：长期记忆与经验生长
// 自实现轻量级向量存储，内建"大运流年（时间衰减）"机制
import { OpenAIEmbeddings } from "@langchain/openai";
import { readFile, writeFile, mkdir } from "fs/promises";
import { existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import cfg from "../../config/wuxing.json" with { type: "json" };
import { logger, EV } from "../utils/logger.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_PATH = join(__dirname, "../../data/wisdom.json");

function cosineSimilarity(a, b) {
    let dot = 0, normA = 0, normB = 0;
    for (let i = 0; i < a.length; i++) {
        dot += a[i] * b[i];
        normA += a[i] * a[i];
        normB += b[i] * b[i];
    }
    if (normA === 0 || normB === 0) return 0;
    return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

export class WisdomMemory {
    /**
     * @param {number} lambda 时间衰减系数（覆盖 config）：越大遗忘越快
     */
    constructor(lambda = cfg.memory.lambda) {
        // 分词模型可通过 EMBEDDING_API_KEY / EMBEDDING_BASE_URL 单独配置
        // 未设置时自动回退到主模型的 OPENAI_API_KEY / OPENAI_BASE_URL
        this.embeddings = new OpenAIEmbeddings({
            modelName:   cfg.models.embedding,
            apiKey:      process.env.EMBEDDING_API_KEY   ?? process.env.OPENAI_API_KEY,
            configuration: {
                baseURL: process.env.EMBEDDING_BASE_URL  ?? process.env.OPENAI_BASE_URL,
            },
        });
        this.lambda = lambda;
        // 内部存储：{ content, embedding, metadata: { result, createdAt, confidence } }
        this.vectors = [];
        // 原始文档（持久化 + 梦境模块访问）
        this.rawDocs = [];
    }

    async init(savedData = []) {
        this.rawDocs = savedData;
        this.vectors = [];
        if (savedData.length > 0) {
            logger.info(EV.WOOD, `正在重建 ${savedData.length} 条经验的向量索引...`);
            for (const d of savedData) {
                const embedding = await this.embeddings.embedQuery(d.task);
                this.vectors.push({
                    content: d.task,
                    embedding,
                    metadata: {
                        result: d.result,
                        createdAt: d.createdAt ?? Date.now(),
                        confidence: d.confidence ?? 1.0,
                    },
                });
            }
        }
    }

    // 水生木：从磁盘恢复记忆
    async loadFromDisk() {
        try {
            if (existsSync(DATA_PATH)) {
                const raw = await readFile(DATA_PATH, "utf-8");
                const savedData = JSON.parse(raw);
                await this.init(savedData);
                logger.info(EV.WOOD, `从磁盘恢复 ${savedData.length} 条因果律`);
                return;
            }
        } catch (e) {
            logger.warn(EV.WOOD, `读取磁盘记忆失败，启用空库: ${e.message}`);
        }
        await this.init([]);
    }

    async saveToDisk() {
        try {
            const dataDir = dirname(DATA_PATH);
            if (!existsSync(dataDir)) {
                await mkdir(dataDir, { recursive: true });
            }
            await writeFile(DATA_PATH, JSON.stringify(this.rawDocs, null, 2), "utf-8");
        } catch (e) {
            logger.warn(EV.WOOD, `保存失败: ${e.message}`);
        }
    }

    /**
     * 火：直觉联想 —— 三因子加权召回（阴阳平衡公式）
     *
     * Score = Similarity × w_sim  +  TimeDecay × w_time  +  Confidence × w_conf
     *
     * 相似度（阳）：语义距离
     * 时效（流年）：exp(-λ × 已过小时数)，新鲜经验权重高
     * 置信（道行）：金节点评分 + 命中次数积累
     * → 老马识途不被误删，短期偏见也不会主导
     */
    async recall(input) {
        if (this.vectors.length === 0) return null;

        const queryEmbedding = await this.embeddings.embedQuery(input);
        const now = Date.now();
        const { similarityWeight, timeDecayWeight, confidenceWeight, recallThreshold } = cfg.scoring;

        let bestScore = 0;
        let bestIdx   = -1;

        for (let i = 0; i < this.vectors.length; i++) {
            const v = this.vectors[i];
            const similarity = cosineSimilarity(queryEmbedding, v.embedding);
            if (similarity < cfg.memory.semanticPreFilter) continue;

            const { createdAt, confidence } = v.metadata;
            const hoursPassed = (now - createdAt) / (1000 * 60 * 60);
            const timeDecay   = Math.exp(-this.lambda * hoursPassed);

            const score =
                similarity  * similarityWeight +
                timeDecay   * timeDecayWeight  +
                confidence  * confidenceWeight;

            if (score > bestScore) {
                bestScore = score;
                bestIdx   = i;
            }
        }

        if (bestScore >= recallThreshold) {
            const hit = this.vectors[bestIdx];
            logger.info(EV.FIRE,
                `三因子得分 ${bestScore.toFixed(3)} ≥ ${recallThreshold}，命中经验库`
            );
            // 命中奖励：hitCount +1，置信度微强化（老马识途）
            await this._reinforce(bestIdx);
            return hit.metadata.result;
        }
        return null;
    }

    // 木：固化经验（写入新因果律，记录出生时刻）
    async memorize(task, result, confidence = 1.0) {
        const embedding = await this.embeddings.embedQuery(task);
        const createdAt = Date.now();

        this.vectors.push({
            content: task, embedding,
            metadata: { result, createdAt, confidence, hitCount: 0 },
        });
        this.rawDocs.push({ task, result, createdAt, confidence, hitCount: 0 });
        logger.evolution(EV.WOOD, `因果律已固化（库存 ${this.rawDocs.length} 条）：${result}`);
        await this.saveToDisk();
    }

    // 内部：命中强化（增加 hitCount，微调置信度）
    async _reinforce(idx) {
        if (idx < 0 || idx >= this.rawDocs.length) return;
        const doc = this.rawDocs[idx];
        doc.hitCount = (doc.hitCount ?? 0) + 1;
        // 每命中10次，置信度 +0.05（上限 1.0）
        if (doc.hitCount % 10 === 0) {
            doc.confidence = Math.min(1.0, (doc.confidence ?? 1.0) + 0.05);
            this.vectors[idx].metadata.confidence = doc.confidence;
            logger.info(EV.WOOD, `经验强化：命中 ${doc.hitCount} 次，置信度升至 ${doc.confidence.toFixed(2)}`);
        }
        this.vectors[idx].metadata.hitCount = doc.hitCount;
        await this.saveToDisk();
    }

    /**
     * 认知对齐（定期调用）：
     * - 淘汰置信度 < minConfidence 的糟粕记忆
     * - 返回淘汰数量
     */
    async refreshConfidence() {
        const before = this.rawDocs.length;
        const { minConfidence } = cfg.scoring;
        const survivors = this.rawDocs.filter((d) => (d.confidence ?? 1.0) >= minConfidence);
        const removed = before - survivors.length;
        if (removed > 0) {
            logger.evolution(EV.WOOD, `认知对齐：淘汰 ${removed} 条低置信记忆（< ${minConfidence}），剩余 ${survivors.length} 条`);
            await this.replaceAll(survivors);
        }
        return removed;
    }

    getAllDocs() {
        return [...this.rawDocs];
    }

    // 金克木：接受修剪/合并后的精简文档，重建索引
    async replaceAll(newDocs) {
        await this.init(newDocs);
        await this.saveToDisk();
    }
}
