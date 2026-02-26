const BASE = "/api";

export async function sendChat(message, sessionMessages = []) {
  const res = await fetch(`${BASE}/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message, sessionMessages }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error ?? "请求失败");
  }
  return res.json();
}

export async function fetchStatus()    { return (await fetch(`${BASE}/status`)).json(); }
export async function fetchSkills()    { return (await fetch(`${BASE}/skills`)).json(); }
export async function fetchWorkspace() { return (await fetch(`${BASE}/workspace`)).json(); }
export async function fetchGoals()     { return (await fetch(`${BASE}/goals`)).json(); }
export async function fetchMemory()    { return (await fetch(`${BASE}/memory`)).json(); }

export async function fetchWorkspaceFile(name) {
  return (await fetch(`${BASE}/workspace/${encodeURIComponent(name)}`)).json();
}

export async function sendCommand(cmd) {
  const res = await fetch(`${BASE}/command`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cmd }),
  });
  return res.json();
}

export async function fetchPendingActions() {
  const res = await fetch(`${BASE}/v1/pending-actions`);
  if (!res.ok) throw new Error("获取审批队列失败");
  return res.json();
}

export async function decideApproval(id, decision, patchedCommand = "", reason = "") {
  const res = await fetch(`${BASE}/v1/approvals/${encodeURIComponent(id)}/decision`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ decision, patchedCommand, reason }),
  });
  return res.json();
}

export async function startExternalAgent({ agentName, taskPrompt, autoApprove = true, timeoutMs = 600000 }) {
  const res = await fetch(`${BASE}/v1/external-agent/start`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ agentName, taskPrompt, autoApprove, timeoutMs }),
  });
  return res.json();
}

export async function fetchExternalTasks() {
  const res = await fetch(`${BASE}/v1/external-agent/tasks`);
  return res.json();
}

export async function sendExternalInput(id, text) {
  const res = await fetch(`${BASE}/v1/external-agent/tasks/${encodeURIComponent(id)}/input`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });
  return res.json();
}

export async function stopExternalTask(id) {
  const res = await fetch(`${BASE}/v1/external-agent/tasks/${encodeURIComponent(id)}/stop`, {
    method: "POST",
  });
  return res.json();
}

// SSE 订阅：返回关闭函数
export function subscribeStream(onEvent) {
  const es = new EventSource(`${BASE}/stream`);
  es.onmessage = (e) => {
    try { onEvent(JSON.parse(e.data)); } catch { /* 静默 */ }
  };
  return () => es.close();
}
