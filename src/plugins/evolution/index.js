// src/plugins/evolution/index.js
// 【进化插件层】—— 将梦境合并 + 熵减修剪封装为可独立注入的钩子
//
// 设计原则：不修改引擎核心代码（wuxingGraph / vectorStore / dream / entropyReducer）
// 使用方式：在 main.js 或任意宿主中 new EvolutionPlugin(wisdomMemory) 即可接入
import { DreamModule } from "../../engine/dream.js";
import { prune } from "../../engine/entropyReducer.js";
import { logger, EV } from "../../utils/logger.js";
import cfg from "../../../config/wuxing.json" with { type: "json" };

export class EvolutionPlugin {
    /**
     * @param {import('../../engine/vectorStore.js').WisdomMemory} wisdomMemory
     */
    constructor(wisdomMemory) {
        this.memory = wisdomMemory;
        this.dream = new DreamModule(wisdomMemory);
        this.taskCount = 0;

        // 从配置读取触发间隔
        this.dreamEvery   = cfg.evolution.dreamTriggerEvery;
        this.entropyEvery = cfg.memory.entropyTriggerEvery;
    }

    /**
     * 每次 Agent 完成一轮任务后调用
     * 插件自动决策是否触发梦境或熵减
     *
     * @param {{ async?: boolean }} options
     *   async=true 时异步执行（不阻塞响应），适合生产环境
     *   async=false 时同步等待（默认），适合演示和测试
     */
    async afterTask(options = { async: false }) {
        this.taskCount++;

        const shouldDream   = this.taskCount % this.dreamEvery   === 0;
        const shouldEntropy = this.taskCount % this.entropyEvery === 0;

        if (!shouldDream && !shouldEntropy) return;

        const run = async () => {
            if (shouldEntropy) {
                logger.info(EV.ENTROPY, `第 ${this.taskCount} 次交互，触发熵减修剪...`);
                await prune(this.memory);
            }

            if (shouldDream) {
                logger.info(EV.DREAM, `第 ${this.taskCount} 次交互，进入梦境整合...`);
                const before = this.memory.getAllDocs().length;
                await this.dream.startDreaming(cfg.memory.dreamMinDocs);
                const after = this.memory.getAllDocs().length;

                if (after < before) {
                    logger.evolution(
                        EV.DREAM,
                        `逻辑折叠完成：${before} 条 → ${after} 条，提炼率 ${((1 - after / before) * 100).toFixed(1)}%`
                    );
                } else {
                    logger.info(EV.DREAM, "本轮梦境：无可折叠群组，经验库保持纯净。");
                }
            }
        };

        if (options.async) {
            // 异步模式：不阻塞主流程，1s 后在后台执行
            setTimeout(() => run().catch((e) => logger.warn(EV.DREAM, `异步进化失败: ${e.message}`)), 1000);
        } else {
            await run();
        }
    }

    /**
     * 手动触发完整进化周期（梦境 + 熵减）
     * 适合定时任务（cron）或空闲时调用
     */
    async fullCycle() {
        logger.info(EV.SYSTEM, "手动触发完整进化周期...");
        await prune(this.memory);
        await this.dream.startDreaming(2);
        logger.info(EV.SYSTEM, `进化周期完成，当前库存 ${this.memory.getAllDocs().length} 条`);
    }
}
