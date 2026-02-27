import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { resolve, join, extname, basename } from "path";

const SEARCH_ROOTS = ["workspace", "skills", "scripts", "src"];
const MAX_FILE_BYTES = 200 * 1024;
const MAX_SCAN_FILES = 1200;
const TEXT_EXTS = new Set([
    ".js", ".jsx", ".ts", ".tsx", ".json", ".md", ".txt", ".yaml", ".yml", ".mjs", ".cjs",
]);

function collectFiles(rootAbs, out) {
    if (!existsSync(rootAbs)) return;
    const stack = [rootAbs];
    while (stack.length > 0 && out.length < MAX_SCAN_FILES) {
        const dir = stack.pop();
        let entries = [];
        try {
            entries = readdirSync(dir, { withFileTypes: true });
        } catch {
            continue;
        }
        for (const e of entries) {
            const full = join(dir, e.name);
            if (e.isDirectory()) {
                if (e.name === "node_modules" || e.name === ".git" || e.name === "dist") continue;
                stack.push(full);
            } else if (e.isFile()) {
                out.push(full);
                if (out.length >= MAX_SCAN_FILES) break;
            }
        }
    }
}

function extractKeywords(goal = "") {
    const text = String(goal).toLowerCase();
    const en = text.match(/[a-z][a-z0-9_-]{1,}/g) ?? [];
    const zh = text.match(/[\u4e00-\u9fa5]{2,}/g) ?? [];
    const raw = [...en, ...zh].filter((s) => !/^(please|help|with|this|that|一下|帮我|请|进行)$/.test(s));
    return [...new Set(raw)].slice(0, 12);
}

function scoreFile(fileAbs, keywords) {
    const fileName = basename(fileAbs).toLowerCase();
    let score = 0;
    const hits = [];

    for (const kw of keywords) {
        if (fileName.includes(kw)) {
            score += 3;
            hits.push(`name:${kw}`);
        }
    }

    const ext = extname(fileAbs).toLowerCase();
    if (!TEXT_EXTS.has(ext)) return { score, hits };

    let content = "";
    try {
        const st = statSync(fileAbs);
        if (st.size > MAX_FILE_BYTES) return { score, hits };
        content = readFileSync(fileAbs, "utf-8").toLowerCase();
    } catch {
        return { score, hits };
    }

    for (const kw of keywords) {
        const idx = content.indexOf(kw);
        if (idx >= 0) {
            score += 1;
            hits.push(`content:${kw}`);
        }
    }
    return { score, hits };
}

export function auditAssets(goal, { maxResults = 5 } = {}) {
    const keywords = extractKeywords(goal);
    const files = [];
    for (const rel of SEARCH_ROOTS) {
        collectFiles(resolve(process.cwd(), rel), files);
    }

    const ranked = [];
    for (const f of files) {
        const { score, hits } = scoreFile(f, keywords);
        if (score <= 0) continue;
        ranked.push({
            path: f.replace(`${process.cwd()}\\`, "").replaceAll("\\", "/"),
            score,
            hits: [...new Set(hits)].slice(0, 5),
        });
    }

    ranked.sort((a, b) => b.score - a.score);
    const top = ranked.slice(0, Math.max(1, maxResults));
    const reuseRecommended = top.length > 0 && top[0].score >= 3;
    const summary = reuseRecommended
        ? `检测到可复用资产 ${top[0].path}（score=${top[0].score}），建议先复用后微调。`
        : "未检测到高匹配资产，可考虑新建实现。";

    return {
        goal: String(goal || "").slice(0, 200),
        keywords,
        scannedFiles: files.length,
        reuseRecommended,
        summary,
        matches: top,
    };
}

