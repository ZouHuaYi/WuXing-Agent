// src/engine/vectorStore.js
// 【木】：长期记忆与经验生长
// 自实现轻量级向量存储，内建"大运流年（时间衰减）"机制
import { OpenAIEmbeddings } from "@langchain/openai";
import { readFile, writeFile, mkdir } from "fs/promises";
import { existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

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
     * @param {number} lambda 时间衰减系数：越大遗忘越快。默认 0.005（约 6 天后权重降至 ~75%）
     */
    constructor(lambda = 0.005) {
        this.embeddings = new OpenAIEmbeddings();
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
            console.log(`[木-记忆] 正在重建 ${savedData.length} 条经验的向量索引...`);
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
                console.log(`[木-记忆] 从磁盘恢复 ${savedData.length} 条因果律`);
                return;
            }
        } catch (e) {
            console.warn("[木-记忆] 读取磁盘记忆失败，启用空库:", e.message);
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
            console.warn("[木-记忆] 保存失败:", e.message);
        }
    }

    /**
     * 火：直觉联想（带大运流年的加权匹配）
     *
     * 综合因果得分 = 语义相似度 × 置信度 × 时间衰减权重
     * 时间衰减：exp(-lambda × 已过小时数)
     * 新鲜的经验全权重，陈旧的经验自动淡化
     */
    async recall(input) {
        if (this.vectors.length === 0) return null;

        const queryEmbedding = await this.embeddings.embedQuery(input);
        const now = Date.now();

        let bestScore = 0;
        let bestResult = null;

        for (const v of this.vectors) {
            const similarity = cosineSimilarity(queryEmbedding, v.embedding);
            if (similarity < 0.70) continue; // 语义相似度预筛选，减少无效计算

            const { result, createdAt, confidence } = v.metadata;
            const hoursPassed = (now - createdAt) / (1000 * 60 * 60);
            const timeWeight = Math.exp(-this.lambda * hoursPassed);
            const finalScore = similarity * confidence * timeWeight;

            if (finalScore > bestScore) {
                bestScore = finalScore;
                bestResult = result;
            }
        }

        if (bestScore > 0.70) {
            console.log(
                `[火-直觉] 综合因果得分 ${bestScore.toFixed(3)}（语义×置信×流年），命中经验库`
            );
            return bestResult;
        }
        return null;
    }

    // 木：固化经验（写入新因果律，记录出生时刻）
    async memorize(task, result, confidence = 1.0) {
        const embedding = await this.embeddings.embedQuery(task);
        const createdAt = Date.now();

        this.vectors.push({ content: task, embedding, metadata: { result, createdAt, confidence } });
        this.rawDocs.push({ task, result, createdAt, confidence });
        await this.saveToDisk();
    }

    // 提升某条记忆的置信度（被再次命中时强化）
    async reinforce(task) {
        const idx = this.rawDocs.findIndex((d) => d.task === task);
        if (idx !== -1) {
            this.rawDocs[idx].confidence = Math.min(1.0, (this.rawDocs[idx].confidence ?? 1.0) + 0.1);
            this.vectors[idx].metadata.confidence = this.rawDocs[idx].confidence;
            await this.saveToDisk();
        }
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
