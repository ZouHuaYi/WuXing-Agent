# scripts/schedule_wakeup.ps1
# WuXing-Agent 自动唤醒脚本
#
# 使用方式（以管理员权限运行 PowerShell）：
#   .\scripts\schedule_wakeup.ps1
#
# 功能：
#   在 Windows 计划任务中注册一个每日定时任务
#   Agent 启动后检查活跃目标晨报，执行后台进化，然后退出
#   输出日志写入 logs/wakeup.log

$ProjectRoot = Split-Path -Parent $PSScriptRoot
$NodeExe     = (Get-Command node -ErrorAction SilentlyContinue)?.Source
$MainScript  = Join-Path $ProjectRoot "main.js"
$LogFile     = Join-Path $ProjectRoot "logs\wakeup.log"
$TaskName    = "WuXingAgent-DailyWakeup"

if (-not $NodeExe) {
    Write-Host "[错误] 未找到 node 可执行文件，请确认 Node.js 已安装并在 PATH 中" -ForegroundColor Red
    exit 1
}

# 唤醒入口脚本（非交互模式，执行晨报后退出）
$WakeupScript = Join-Path $ProjectRoot "scripts\wakeup_run.mjs"

# 创建唤醒入口（如不存在则生成）
if (-not (Test-Path $WakeupScript)) {
    $wakeupContent = @'
// scripts/wakeup_run.mjs — 非交互唤醒模式
// 计划任务调用此脚本：加载目标、执行晨报、写日志、退出
import "dotenv/config";
import { goalTracker }  from "../src/engine/goalTracker.js";
import { wisdomMemory } from "../src/engine/wuxingGraph.js";
import { logger, EV }   from "../src/utils/logger.js";
import cfg from "../config/wuxing.json" with { type: "json" };
import { appendFileSync } from "fs";
import { join } from "path";

const LOG = join(process.cwd(), "logs/wakeup.log");
const ts  = () => new Date().toLocaleString("zh-CN");

function log(msg) {
    const line = `[${ts()}] ${msg}\n`;
    process.stdout.write(line);
    appendFileSync(LOG, line);
}

await logger.init(cfg.evolution.logFile);
await wisdomMemory.loadFromDisk();

const active = goalTracker.list("active");
log(`=== WuXing-Agent 晨醒 === 活跃目标 ${active.length} 个`);

if (active.length > 0) {
    const briefing = await goalTracker.briefing();
    log(briefing ?? "(无目标摘要)");
    for (const g of active) {
        log(`目标 [${g.progress}%] ${g.title}`);
        if (g.milestones.length > 0) {
            const pending = g.milestones.filter(m => !m.done);
            if (pending.length > 0) {
                log(`  待完成里程碑：${pending.map(m => m.title).join(" / ")}`);
            }
        }
    }
} else {
    log("当前无活跃目标，使用 :vision 添加你的长期愿景");
}

log("=== 晨醒结束，进入待机 ===");
process.exit(0);
'@
    Set-Content -Path $WakeupScript -Value $wakeupContent -Encoding UTF8
    Write-Host "[已生成] $WakeupScript" -ForegroundColor Cyan
}

# 设置计划任务触发时间（默认每天早上 8:30）
$TriggerTime = "08:30"

# 删除同名旧任务（幂等）
Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue

$Action  = New-ScheduledTaskAction `
    -Execute $NodeExe `
    -Argument "--experimental-vm-modules `"$WakeupScript`"" `
    -WorkingDirectory $ProjectRoot

$Trigger = New-ScheduledTaskTrigger -Daily -At $TriggerTime

$Settings = New-ScheduledTaskSettingsSet `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 5) `
    -MultipleInstances IgnoreNew `
    -StartWhenAvailable

Register-ScheduledTask `
    -TaskName   $TaskName `
    -Action     $Action `
    -Trigger    $Trigger `
    -Settings   $Settings `
    -RunLevel   Limited `
    -Description "WuXing-Agent 每日晨醒：检查长期目标进度，写入唤醒日志" | Out-Null

Write-Host ""
Write-Host "  计划任务已注册：$TaskName" -ForegroundColor Green
Write-Host "  触发时间       ：每天 $TriggerTime"
Write-Host "  工作目录       ：$ProjectRoot"
Write-Host "  日志文件       ：$LogFile"
Write-Host ""
Write-Host "  手动测试（立即运行）："
Write-Host "    Start-ScheduledTask -TaskName '$TaskName'"
Write-Host ""
Write-Host "  取消注册："
Write-Host "    Unregister-ScheduledTask -TaskName '$TaskName' -Confirm:`$false"
Write-Host ""
