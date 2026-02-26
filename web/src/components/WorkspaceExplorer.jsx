import React, { useState, useEffect } from "react";
import { fetchWorkspace, fetchWorkspaceFile } from "../lib/api.js";
import { FileCode, RefreshCw, FolderOpen, X } from "lucide-react";

function fileIcon(name) {
  if (name.endsWith(".py"))  return "🐍";
  if (name.endsWith(".js") || name.endsWith(".mjs")) return "📜";
  if (name.endsWith(".json")) return "📋";
  if (name.endsWith(".md"))   return "📝";
  if (name.endsWith(".txt"))  return "📄";
  return "📁";
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes}B`;
  return `${(bytes / 1024).toFixed(1)}KB`;
}

export default function WorkspaceExplorer() {
  const [files, setFiles]       = useState([]);
  const [selected, setSelected] = useState(null);
  const [content, setContent]   = useState("");
  const [loading, setLoading]   = useState(false);

  async function load() {
    setLoading(true);
    try {
      const data = await fetchWorkspace();
      setFiles(data.files ?? []);
    } finally {
      setLoading(false);
    }
  }

  async function openFile(name) {
    setSelected(name);
    const data = await fetchWorkspaceFile(name);
    setContent(data.content ?? "");
  }

  useEffect(() => { load(); }, []);

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-gray-800 shrink-0">
        <FolderOpen size={13} className="text-yellow-400" />
        <span className="text-xs font-semibold text-gray-300 flex-1">工作区</span>
        <button onClick={load} disabled={loading}
          className="text-gray-500 hover:text-gray-300 transition-colors disabled:opacity-40">
          <RefreshCw size={12} className={loading ? "animate-spin" : ""} />
        </button>
      </div>

      {/* 文件列表 */}
      {!selected ? (
        <div className="flex-1 overflow-y-auto">
          {files.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full text-gray-600 text-xs gap-2">
              <FolderOpen size={24} />
              <span>工作区为空</span>
            </div>
          ) : (
            files.map((f) => (
              <button
                key={f.name}
                onClick={() => !f.isDir && openFile(f.name)}
                className="w-full flex items-center gap-2.5 px-3 py-2 hover:bg-gray-800/50
                  text-left transition-colors group"
              >
                <span className="text-base shrink-0">{fileIcon(f.name)}</span>
                <span className="flex-1 text-xs text-gray-300 truncate group-hover:text-white transition-colors">
                  {f.name}
                </span>
                <span className="text-[10px] text-gray-600 shrink-0">
                  {formatSize(f.size)}
                </span>
              </button>
            ))
          )}
        </div>
      ) : (
        /* 文件内容预览 */
        <div className="flex-1 flex flex-col min-h-0">
          <div className="flex items-center gap-2 px-3 py-1.5 border-b border-gray-800 bg-gray-900 shrink-0">
            <FileCode size={12} className="text-purple-400" />
            <span className="text-[11px] text-gray-300 flex-1 truncate font-mono">{selected}</span>
            <button onClick={() => setSelected(null)}
              className="text-gray-500 hover:text-gray-300">
              <X size={12} />
            </button>
          </div>
          <div className="flex-1 overflow-auto p-3">
            <pre className="text-[11px] text-gray-300 font-mono leading-relaxed whitespace-pre-wrap break-all">
              {content}
            </pre>
          </div>
        </div>
      )}
    </div>
  );
}
