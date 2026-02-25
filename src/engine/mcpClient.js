// src/engine/mcpClient.js
// 【水-协议】：MCP（Model Context Protocol）客户端连接池
//
// 职责：
//   - 管理到多个 MCP 服务进程（stdio / SSE）的持久连接
//   - 将 MCP 工具暴露为 { config, handler } 对，供 skillManager 挂载
//   - 严格管理子进程生命周期（连接、断开、异常恢复）
//
// MCP 服务配置（config/mcp.json）示例：
//   {
//     "mcpServers": {
//       "everything": {
//         "command": "npx",
//         "args": ["-y", "@modelcontextprotocol/server-everything"],
//         "description": "MCP 参考实现，含多种示例工具"
//       },
//       "my-server": {
//         "command": "node",
//         "args": ["C:/path/to/server/index.js"],
//         "env": { "API_KEY": "xxx" }
//       }
//     }
//   }
import { Client }               from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { join }                 from "path";
import { logger, EV }           from "../utils/logger.js";
import { PROJECT_ROOT }         from "./toolBox.js";

const MCP_CONFIG_PATH = join(PROJECT_ROOT, "config", "mcp.json");

// 连接状态枚举
const Status = { DISCONNECTED: "disconnected", CONNECTING: "connecting", CONNECTED: "connected", FAILED: "failed" };

// ── 单个服务连接 ───────────────────────────────────────────────────────────────
class MCPServerConnection {
    constructor(serverName, serverConfig) {
        this.serverName   = serverName;
        this.serverConfig = serverConfig;
        this.client       = null;
        this.transport    = null;
        this.tools        = [];   // { name, description, inputSchema }
        this.status       = Status.DISCONNECTED;
        this.error        = null;
    }

    async connect() {
        if (this.status === Status.CONNECTED) return true;

        this.status = Status.CONNECTING;
        this.error  = null;

        const { command, args = [], env = {} } = this.serverConfig;

        try {
            this.transport = new StdioClientTransport({
                command,
                args,
                env: { ...process.env, ...env },
            });

            this.client = new Client(
                { name: "WuXing-MCP-Client", version: "1.0.0" },
                { capabilities: {} }
            );

            await this.client.connect(this.transport);

            // 获取服务提供的工具列表
            const { tools } = await this.client.listTools();
            this.tools  = tools ?? [];
            this.status = Status.CONNECTED;

            logger.info(EV.WATER,
                `MCP 连接成功：${this.serverName}（${this.tools.length} 个工具）`
            );
            return true;

        } catch (e) {
            this.status = Status.FAILED;
            this.error  = e.message;
            logger.warn(EV.METAL,
                `[金-审计] MCP 连接失败：${this.serverName} — ${e.message}`
            );
            return false;
        }
    }

    async disconnect() {
        if (!this.client) return;
        try {
            await this.client.close();
        } catch { /* ignore cleanup errors */ }
        this.client    = null;
        this.transport = null;
        this.tools     = [];
        this.status    = Status.DISCONNECTED;
    }

    async callTool(toolName, args = {}) {
        if (this.status !== Status.CONNECTED) {
            throw new Error(`MCP 服务 "${this.serverName}" 未连接（状态：${this.status}）`);
        }
        const result = await this.client.callTool({ name: toolName, arguments: args });
        // MCP 返回 content 数组，提取文本
        return result.content
            ?.map((c) => (c.type === "text" ? c.text : JSON.stringify(c)))
            .join("\n") ?? "(无输出)";
    }

    // 生成 LangChain 可用的 { config, handler } 列表
    toLangChainPairs() {
        return this.tools.map((t) => ({
            config: {
                name:        `${this.serverName}__${t.name}`,  // 加前缀避免命名冲突
                description: `[MCP:${this.serverName}] ${t.description ?? t.name}`,
                parameters:  t.inputSchema ?? { type: "object", properties: {}, required: [] },
            },
            handler: async (args) => this.callTool(t.name, args),
            isStub:  false,
            source:  `MCP:${this.serverName}`,
        }));
    }
}

// ── MCP 客户端连接池（单例）────────────────────────────────────────────────────
export class MCPClientPool {
    constructor() {
        this.connections = new Map();  // serverName → MCPServerConnection
    }

    // ── 配置文件读写 ────────────────────────────────────
    loadConfig() {
        if (!existsSync(MCP_CONFIG_PATH)) return {};
        try {
            const raw = readFileSync(MCP_CONFIG_PATH, "utf-8");
            return JSON.parse(raw).mcpServers ?? {};
        } catch (e) {
            logger.warn(EV.METAL, `[金-审计] mcp.json 读取失败：${e.message}`);
            return {};
        }
    }

    saveConfig(servers) {
        const existing = existsSync(MCP_CONFIG_PATH)
            ? JSON.parse(readFileSync(MCP_CONFIG_PATH, "utf-8"))
            : {};
        existing.mcpServers = servers;
        writeFileSync(MCP_CONFIG_PATH, JSON.stringify(existing, null, 2), "utf-8");
    }

    // ── 连接管理 ────────────────────────────────────────
    async connectAll() {
        const servers = this.loadConfig();
        if (Object.keys(servers).length === 0) return;

        logger.info(EV.WATER, `MCP：尝试连接 ${Object.keys(servers).length} 个服务...`);

        await Promise.allSettled(
            Object.entries(servers).map(([name, cfg]) => this.connectServer(name, cfg))
        );
    }

    async connectServer(name, cfg) {
        // 如果已有连接先断开（热重连）
        if (this.connections.has(name)) {
            await this.connections.get(name).disconnect();
        }
        const conn = new MCPServerConnection(name, cfg);
        this.connections.set(name, conn);
        return conn.connect();
    }

    async disconnectAll() {
        await Promise.allSettled(
            [...this.connections.values()].map((c) => c.disconnect())
        );
        this.connections.clear();
    }

    // ── 技能加载 ────────────────────────────────────────
    // 返回所有已连接服务的工具对，供 skillManager 使用
    getAllToolPairs() {
        const pairs = [];
        for (const conn of this.connections.values()) {
            if (conn.status === Status.CONNECTED) {
                pairs.push(...conn.toLangChainPairs());
            }
        }
        return pairs;
    }

    // ── 动态安装 ────────────────────────────────────────
    /**
     * 注册一个新 MCP 服务到 mcp.json，并立即尝试连接
     * @param {string} name       服务标识（如 "everything"）
     * @param {object} serverCfg  { command, args, env?, description? }
     * @returns {{ success: boolean, toolCount: number, error?: string }}
     */
    async installServer(name, serverCfg) {
        const servers = this.loadConfig();

        if (servers[name]) {
            logger.info(EV.WATER, `MCP：更新已有服务配置 ${name}`);
        }

        servers[name] = serverCfg;
        this.saveConfig(servers);
        logger.info(EV.WATER, `MCP：已写入 mcp.json → ${name}`);

        const ok = await this.connectServer(name, serverCfg);
        if (!ok) {
            const conn = this.connections.get(name);
            return { success: false, toolCount: 0, error: conn?.error ?? "连接失败" };
        }

        const conn = this.connections.get(name);
        return { success: true, toolCount: conn.tools.length };
    }

    // ── 状态摘要 ────────────────────────────────────────
    getStatus() {
        const result = {};
        for (const [name, conn] of this.connections) {
            result[name] = {
                status:    conn.status,
                toolCount: conn.tools.length,
                tools:     conn.tools.map((t) => t.name),
                error:     conn.error,
            };
        }
        return result;
    }
}

export const mcpPool = new MCPClientPool();
