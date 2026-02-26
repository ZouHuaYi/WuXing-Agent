// src/memory/vectorMemory.js
// 【木-长期记忆】：分层语义向量记忆系统
//
// 三层记忆架构：
//
//   core      ── 核心准则，永不被裁剪。由 :pin 命令或高置信度反思写入。
//   long_term ── 长期经验，随时间衰减，可被进化插件压缩。（默认层）
//   short_term── 本轮会话摘要，过期后自动降级至 long_term 或丢弃。
//
// 召回策略（优先级递减）：
//   1. core 层全量检索（权重 boost × 1.5）
//   2. long_term + short_term 语义相似度
//   3. 合并 Top-K，返回格式化背景上下文
//
// 设计原则：
//   - 不破坏 WisdomMemory 的任何现有接口
//   - 纯粹是上层封装 + 扩展，WisdomMemory 继续作为存储后端
//   - 写入新记忆时自动携带 memory_type 字段
import { cosineSimilarity } from "../engine/vectorStore.js";
import { logger, EV }       from "../utils/logger.js";
import cfg                  from "../../config/wuxing.json" with { type: "json" };

// 各层默认权重 boost（乘以原始相似度分）
const LAYER_BOOST = {
    core:       1.5,   // 核心准则放大相关性
    long_term:  1.0,   // 标准权重
    short_term: 0.7,   // 短期记忆略降（避免刷屏）
};

// short_term 超过此天数自动降级
const SHORT_TERM_EXPIRE_DAYS = 1;

/**
 * 分层语义向量记忆系统
 * 依赖 WisdomMemory 实例作为底层存储，提供 Top-K 分层召回能力
 */
export class VectorMemory {
    /**
     * @param {import("../engine/vectorStore.js").WisdomMemory} wisdomMemory
     */
    constructor(wisdomMemory) {
        this.mem    = wisdomMemory;
        this.lambda = cfg.memory.lambda;
    }

    // ── 写入 ────────────────────────────────────────────────
    /**
     * 写入记忆
     * @param {string} task       记忆的"问题/任务/场景"
     * @param {string} result     记忆的"答案/准则/经验"
     * @param {object} opts
     * @param {number} [opts.confidence=1.0]
     * @param {"core"|"long_term"|"short_term"} [opts.memory_type="long_term"]
     */
    async add(task, result, { confidence = 1.0, memory_type = "long_term" } = {}) {
        // 复用 WisdomMemory.memorize，传入 memory_type 作为额外元数据
        await this.mem.memorize(task, result, confidence, memory_type);
        logger.info(EV.WOOD, `[VectorMemory] 写入 ${memory_type} 层：${result.slice(0, 50)}`);
    }

    /**
     * 钉住核心记忆（:pin 命令调用）
     */
    async pin(rule, context = "") {
        const task = context || `【核心准则】${rule}`;
        await this.add(task, rule, { confidence: 1.0, memory_type: "core" });
        logger.info(EV.WOOD, `[VectorMemory] 核心记忆已钉住：${rule.slice(0, 60)}`);
    }

    // ── Top-K 语义召回 ──────────────────────────────────────
    /**
     * 返回与查询最相关的 Top-K 记忆，按层级加权打分
     * @param {string} query
     * @param {number} [k=5]
     * @returns {Promise<RecallResult[]>}
     */
    async searchTopK(query, k = 5) {
        const vectors = this.mem.vectors;
        if (vectors.length === 0) return [];

        const queryVec = await this.mem.embeddings.embedQuery(query);
        const now      = Date.now();
        const { similarityWeight, timeDecayWeight, confidenceWeight } = cfg.scoring;

        const scored = vectors.map((v) => {
            const rawDoc     = this.mem.rawDocs[vectors.indexOf(v)];
            const memType    = rawDoc?.memory_type ?? "long_term";
            const similarity = cosineSimilarity(queryVec, v.embedding);

            if (similarity < cfg.memory.semanticPreFilter * 0.7) return null;  // 更宽松的前置过滤

            const { createdAt, confidence } = v.metadata;
            const hoursPassed = (now - createdAt) / (1000 * 60 * 60);

            // short_term 超期自动降权（不删除，只召回时降级）
            const effectiveType = (memType === "short_term" && hoursPassed > SHORT_TERM_EXPIRE_DAYS * 24)
                ? "long_term"
                : memType;

            const timeDecay = Math.exp(-this.lambda * hoursPassed);
            const boost     = LAYER_BOOST[effectiveType] ?? 1.0;

            const score = boost * (
                similarity * similarityWeight +
                timeDecay  * timeDecayWeight  +
                confidence * confidenceWeight
            );

            return {
                task:        v.content,
                result:      v.metadata.result,
                score,
                similarity,
                memType:     effectiveType,
                confidence,
                createdAt,
            };
        }).filter(Boolean);

        // 按 score 降序取 Top-K
        scored.sort((a, b) => b.score - a.score);
        return scored.slice(0, k);
    }

    /**
     * 格式化 Top-K 记忆为推理节点可直接使用的上下文字符串
     * @param {string} query
     * @param {number} [k=5]
     * @param {number} [minScore=0.3]   低于此分数不显示
     * @returns {Promise<string>}       空字符串表示无相关记忆
     */
    async buildContext(query, k = 5, minScore = 0.3) {
        const hits = await this.searchTopK(query, k);
        const relevant = hits.filter((h) => h.score >= minScore);
        if (relevant.length === 0) return "";

        const lines = relevant.map((h, i) => {
            const tag = h.memType === "core"
                ? "【核心】"
                : h.memType === "short_term"
                    ? "【近期】"
                    : "【经验】";
            return `${i + 1}. ${tag} ${h.result}`;
        });

        logger.info(EV.FIRE,
            `Top-K 语义召回 ${relevant.length} 条（最高分 ${relevant[0].score.toFixed(3)}）`
        );

        return lines.join("\n");
    }

    // ── 统计 ────────────────────────────────────────────────
    stats() {
        const counts = { core: 0, long_term: 0, short_term: 0, total: 0 };
        for (const doc of this.mem.rawDocs) {
            const t = doc.memory_type ?? "long_term";
            counts[t]    = (counts[t]    ?? 0) + 1;
            counts.total += 1;
        }
        return counts;
    }
}

/**
 * @typedef {Object} RecallResult
 * @property {string} task
 * @property {string} result
 * @property {number} score
 * @property {number} similarity
 * @property {"core"|"long_term"|"short_term"} memType
 * @property {number} confidence
 * @property {number} createdAt
 */
