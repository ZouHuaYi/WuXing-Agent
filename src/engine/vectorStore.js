// src/engine/vectorStore.js
// 【木】：长期记忆与经验生长
//
// 存储布局：
//   data/wisdom.json      ← 原始文档（task / result / createdAt / confidence / hitCount）
//   data/wisdom.vec.json  ← 向量缓存（md5(task) → float[] ），启动时跳过 API 调用
//
// 缓存策略：
//   命中缓存 → 直接读取，0 API 调用
//   未命中  → 调用嵌入 API，写入缓存
//   replaceAll 后 → 自动清除孤立缓存条目
import { OpenAIEmbeddings } from "@langchain/openai";
import { readFile, writeFile, mkdir } from "fs/promises";
import { existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { createHash } from "crypto";
import cfg from "../../config/wuxing.json" with { type: "json" };
import { logger, EV } from "../utils/logger.js";

const __dirname  = dirname(fileURLToPath(import.meta.url));
const DATA_PATH  = join(__dirname, "../../data/wisdom.json");
const VEC_PATH   = join(__dirname, "../../data/wisdom.vec.json");

// task 文本 → MD5 hex（缓存键）
function hashTask(task) {
    return createHash("md5").update(String(task)).digest("hex");
}

function cosineSimilarity(a, b) {
    let dot = 0, normA = 0, normB = 0;
    for (let i = 0; i < a.length; i++) {
        dot  += a[i] * b[i];
        normA += a[i] * a[i];
        normB += b[i] * b[i];
    }
    if (normA === 0 || normB === 0) return 0;
    return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

export class WisdomMemory {
    constructor(lambda = cfg.memory.lambda) {
        this.embeddings = new OpenAIEmbeddings({
            modelName:   cfg.models.embedding,
            apiKey:      process.env.EMBEDDING_API_KEY ?? process.env.OPENAI_API_KEY,
            configuration: {
                baseURL: process.env.EMBEDDING_BASE_URL ?? process.env.OPENAI_BASE_URL,
            },
        });
        this.lambda  = lambda;
        this.vectors = [];   // 内存索引：{ content, embedding, metadata }
        this.rawDocs = [];   // 原始文档（落盘 + 梦境模块读写）
    }

    // ── 向量缓存 I/O ────────────────────────────────────────

    async _loadVecCache() {
        try {
            if (existsSync(VEC_PATH)) {
                return JSON.parse(await readFile(VEC_PATH, "utf-8"));
            }
        } catch { /* 损坏缓存丢弃即可 */ }
        return {};
    }

    async _saveVecCache(cache) {
        try {
            const dir = dirname(VEC_PATH);
            if (!existsSync(dir)) await mkdir(dir, { recursive: true });
            await writeFile(VEC_PATH, JSON.stringify(cache), "utf-8");
        } catch (e) {
            logger.warn(EV.WOOD, `向量缓存写入失败：${e.message}`);
        }
    }

    // 将当前内存索引的所有向量重写到缓存（用于剪枝/合并后清理孤立条目）
    async _syncCacheFromMemory() {
        const cache = {};
        for (const v of this.vectors) {
            cache[hashTask(v.content)] = v.embedding;
        }
        await this._saveVecCache(cache);
    }

    // ── 初始化：重建内存索引（优先命中向量缓存）──────────────

    async init(savedData = []) {
        this.rawDocs = savedData;
        this.vectors = [];
        if (savedData.length === 0) return;

        const cache   = await this._loadVecCache();
        let hits = 0, misses = 0;

        logger.info(EV.WOOD, `正在重建 ${savedData.length} 条经验的向量索引...`);

        for (const d of savedData) {
            const h = hashTask(d.task);
            let embedding;

            if (cache[h]) {
                embedding = cache[h];
                hits++;
            } else {
                embedding = await this.embeddings.embedQuery(d.task);
                cache[h]  = embedding;
                misses++;
            }

            this.vectors.push({
                content:  d.task,
                embedding,
                metadata: {
                    result:     d.result,
                    createdAt:  d.createdAt  ?? Date.now(),
                    confidence: d.confidence ?? 1.0,
                    hitCount:   d.hitCount   ?? 0,
                },
            });
        }

        // 仅当有新向量时才写回磁盘
        if (misses > 0) {
            await this._saveVecCache(cache);
        }

        const label = misses === 0
            ? `全部命中缓存，API 调用 0 次`
            : `命中缓存 ${hits} 条，新算 ${misses} 条`;
        logger.info(EV.WOOD, `向量索引就绪（${label}）`);
    }

    // ── 磁盘 I/O ─────────────────────────────────────────────

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
            const dir = dirname(DATA_PATH);
            if (!existsSync(dir)) await mkdir(dir, { recursive: true });
            await writeFile(DATA_PATH, JSON.stringify(this.rawDocs, null, 2), "utf-8");
        } catch (e) {
            logger.warn(EV.WOOD, `保存失败: ${e.message}`);
        }
    }

    // ── 三因子加权召回 ───────────────────────────────────────
    //
    //   Score = Similarity × w_sim  +  TimeDecay × w_time  +  Confidence × w_conf
    //
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
                similarity * similarityWeight +
                timeDecay  * timeDecayWeight  +
                confidence * confidenceWeight;

            if (score > bestScore) {
                bestScore = score;
                bestIdx   = i;
            }
        }

        if (bestScore >= recallThreshold) {
            logger.info(EV.FIRE, `三因子得分 ${bestScore.toFixed(3)} ≥ ${recallThreshold}，命中经验库`);
            await this._reinforce(bestIdx);
            return this.vectors[bestIdx].metadata.result;
        }
        return null;
    }

    // ── 固化经验 ─────────────────────────────────────────────

    async memorize(task, result, confidence = 1.0) {
        const h         = hashTask(task);
        const embedding = await this.embeddings.embedQuery(task);
        const createdAt = Date.now();

        this.vectors.push({
            content: task, embedding,
            metadata: { result, createdAt, confidence, hitCount: 0 },
        });
        this.rawDocs.push({ task, result, createdAt, confidence, hitCount: 0 });

        // 新向量写入缓存（下次启动无需重算）
        const cache  = await this._loadVecCache();
        cache[h]     = embedding;
        await this._saveVecCache(cache);

        logger.evolution(EV.WOOD, `因果律已固化（库存 ${this.rawDocs.length} 条）：${result}`);
        await this.saveToDisk();
    }

    // ── 命中强化 ─────────────────────────────────────────────

    async _reinforce(idx) {
        if (idx < 0 || idx >= this.rawDocs.length) return;
        const doc = this.rawDocs[idx];
        doc.hitCount = (doc.hitCount ?? 0) + 1;
        // 每命中 10 次，置信度 +0.05（上限 1.0）
        if (doc.hitCount % 10 === 0) {
            doc.confidence = Math.min(1.0, (doc.confidence ?? 1.0) + 0.05);
            this.vectors[idx].metadata.confidence = doc.confidence;
            logger.info(EV.WOOD, `经验强化：命中 ${doc.hitCount} 次，置信度升至 ${doc.confidence.toFixed(2)}`);
        }
        this.vectors[idx].metadata.hitCount = doc.hitCount;
        await this.saveToDisk();
    }

    // ── 认知对齐（淘汰低置信度糟粕）────────────────────────────

    async refreshConfidence() {
        const before     = this.rawDocs.length;
        const { minConfidence } = cfg.scoring;
        const survivors  = this.rawDocs.filter((d) => (d.confidence ?? 1.0) >= minConfidence);
        const removed    = before - survivors.length;
        if (removed > 0) {
            logger.evolution(EV.WOOD,
                `认知对齐：淘汰 ${removed} 条低置信记忆（< ${minConfidence}），剩余 ${survivors.length} 条`
            );
            await this.replaceAll(survivors);
        }
        return removed;
    }

    getAllDocs() {
        return [...this.rawDocs];
    }

    // ── 金克木：接受修剪/合并后的精简文档，重建索引 + 清理孤立缓存 ──

    async replaceAll(newDocs) {
        await this.init(newDocs);
        await this.saveToDisk();
        // 重写缓存文件，清除被剪枝的孤立条目
        await this._syncCacheFromMemory();
    }
}
