import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, resolve } from "path";

const EXPERIENCE_FILE = resolve(process.cwd(), "data/experience_map.json");
const MAX_ITEMS = 400;

function loadStore() {
    try {
        if (!existsSync(EXPERIENCE_FILE)) return { items: [] };
        const parsed = JSON.parse(readFileSync(EXPERIENCE_FILE, "utf-8"));
        return { items: Array.isArray(parsed?.items) ? parsed.items : [] };
    } catch {
        return { items: [] };
    }
}

function saveStore(store) {
    const dir = dirname(EXPERIENCE_FILE);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(EXPERIENCE_FILE, `${JSON.stringify(store, null, 2)}\n`, "utf-8");
}

function keywordsOf(text = "") {
    const s = String(text).toLowerCase();
    const en = s.match(/[a-z][a-z0-9_-]{1,}/g) ?? [];
    const zh = s.match(/[\u4e00-\u9fa5]{2,}/g) ?? [];
    const words = [...en, ...zh].filter((w) => !/^(please|help|with|this|that|一下|帮我|请|进行)$/.test(w));
    return [...new Set(words)].slice(0, 16);
}

function overlapScore(a, b) {
    if (a.length === 0 || b.length === 0) return 0;
    const setA = new Set(a);
    let hit = 0;
    for (const w of b) if (setA.has(w)) hit++;
    return hit / Math.max(setA.size, new Set(b).size);
}

export function queryExperience(task, { topK = 3 } = {}) {
    const store = loadStore();
    const qk = keywordsOf(task);
    const scored = store.items
        .map((item) => ({ item, score: overlapScore(qk, item.keywords ?? []) }))
        .filter((x) => x.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, topK)
        .map((x) => ({
            source: "index",
            score: Number(x.score.toFixed(3)),
            task: x.item.task,
            tier: x.item.tier,
            decision: x.item.decision,
            assetPath: x.item.assetPath || "",
            status: x.item.status,
            ts: x.item.ts,
        }));

    return {
        keywords: qk,
        hits: scored,
        hit: scored.length > 0,
    };
}

function mergeHits(indexHits, memoryHits, topK) {
    const merged = [];
    const seen = new Set();

    const push = (h) => {
        const key = `${h.task}|${h.assetPath || ""}`;
        if (seen.has(key)) return;
        seen.add(key);
        merged.push(h);
    };

    for (const h of memoryHits) push(h);
    for (const h of indexHits) push(h);
    merged.sort((a, b) => b.score - a.score);
    return merged.slice(0, topK);
}

export async function queryExperienceUnified(task, {
    topK = 3,
    vectorMemory = null,
} = {}) {
    const indexed = queryExperience(task, { topK });
    let memoryHits = [];

    if (vectorMemory?.searchTopK) {
        try {
            const recalls = await vectorMemory.searchTopK(task, topK);
            memoryHits = (recalls ?? []).map((r) => ({
                source: "memory",
                score: Number((r.score ?? 0).toFixed(3)),
                task: r.task || "",
                tier: "MEMORY",
                decision: "RECALL",
                assetPath: "",
                status: "success",
                ts: r.createdAt || 0,
            }));
        } catch {
            memoryHits = [];
        }
    }

    const hits = mergeHits(indexed.hits, memoryHits, topK);
    return {
        keywords: indexed.keywords,
        hits,
        hit: hits.length > 0,
    };
}

export function recordExperience({
    task,
    tier = "",
    decision = "",
    assetPath = "",
    status = "success",
    note = "",
}) {
    const store = loadStore();
    const entry = {
        task: String(task || "").slice(0, 220),
        keywords: keywordsOf(task),
        tier,
        decision,
        assetPath: String(assetPath || "").slice(0, 220),
        status,
        note: String(note || "").slice(0, 240),
        ts: Date.now(),
    };
    store.items.unshift(entry);
    if (store.items.length > MAX_ITEMS) store.items = store.items.slice(0, MAX_ITEMS);
    saveStore(store);
    return entry;
}

export async function recordExperienceUnified({
    task,
    tier = "",
    decision = "",
    assetPath = "",
    status = "success",
    note = "",
    vectorMemory = null,
}) {
    const entry = recordExperience({ task, tier, decision, assetPath, status, note });
    if (status === "success" && vectorMemory?.add) {
        try {
            const memo = `经验映射：任务可复用${entry.assetPath ? ` ${entry.assetPath}` : "既有实现"}；策略=${entry.decision || tier || "local_first"}`;
            await vectorMemory.add(entry.task, memo, {
                confidence: 0.55,
                memory_type: "short_term",
            });
        } catch {
            // Ignore bridge errors to keep main flow stable.
        }
    }
    return entry;
}

export function listRecentExperience(limit = 30) {
    const store = loadStore();
    return store.items.slice(0, limit);
}
