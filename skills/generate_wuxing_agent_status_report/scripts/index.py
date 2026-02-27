import sys, json, datetime, platform, subprocess, psutil

def handler(args):
    current_workspace_files = args.get('current_workspace_files', [])
    pending_tasks = args.get('pending_tasks', [])
    
    # 获取系统平台
    system_platform = f"{platform.system().lower()} {platform.architecture()[0]}"
    
    # 获取Node.js版本
    try:
        node_version = subprocess.run(['node', '-v'], capture_output=True, text=True, timeout=5).stdout.strip()
    except (subprocess.CalledProcessError, FileNotFoundError, TimeoutError):
        node_version = "未安装"
    
    # 获取内存状态
    vm = psutil.virtual_memory()
    used_mb = vm.used // (1024 * 1024)
    total_mb = vm.total // (1024 * 1024)
    free_mb = vm.available // (1024 * 1024)
    memory_status = f"已用{used_mb}MB / 总{total_mb}MB (剩余{free_mb}MB)"
    
    # 获取当前时间
    current_time = datetime.datetime.now().strftime('%Y-%m-%d %A')
    
    # 生成报告内容
    report = f"# 🤖 WuXing-Agent 自我状态报告\n\n"
    report += "## 📊 实时运行环境\n"
    report += f"- **系统平台**: {system_platform}\n"
    report += f"- **Node.js版本**: {node_version}\n"
    report += f"- **内存状态**: {memory_status}\n"
    report += f"- **当前时间**: {current_time}\n\n"
    
    report += "## 🛠️ 核心能力\n"
    report += "作为具备五行自进化能力的编程专家，我可以：\n"
    report += "1. **文件操作**: 读取项目文件、写入安全隔离的workspace目录\n"
    report += "2. **代码执行**: 运行Node.js代码并提供测试验证\n"
    report += "3. **技能内化**: 将通过测试的代码转化为永久技能卡\n"
    report += "4. **依赖管理**: 按需安装npm包\n"
    report += "5. **外部协作**: 调用外部专家代理（codex/claude）\n\n"
    
    report += "## 📋 标准工作流\n"
    report += "```mermaid\n"
    report += "graph LR\n"
    report += "A[探路<br>list_dir/read_file] --> B[编码<br>write_file]\n"
    report += "B --> C[验证<br>test_runner]\n"
    report += "C -->|失败| B\n"
    report += "C -->|成功| D[内化<br>incorporate_skill]\n"
    report += "```\n\n"
    
    report += "## 📂 当前工作区文件\n"
    if current_workspace_files:
        for file in current_workspace_files:
            report += f"- `{file}`\n"
    else:
        report += "- 无\n"
    report += "\n"
    
    report += "## 🧠 历史经验库\n"
    report += "1. 当无法直接获取特定版本发布信息时，应提供权威官方渠道作为替代方案\n"
    report += "2. 当需完成编程全生命周期任务时，应遵循探路→编码→验证→内化闭环\n"
    report += "3. 当Node.js项目启用ES Module时，应遵循对应语法、路径处理及配置规则\n"
    report += "4. 当代理配置与工具运行逻辑不匹配时，应对齐标准模式并补充必要配置项\n\n"
    
    report += "## 🎯 待办事项\n"
    if pending_tasks:
        for task in pending_tasks:
            report += f"- {task}\n"
    else:
        report += "- 无\n"
    
    report += "\n---\n随时可以向我提出编程需求"
    
    return report

if __name__ == '__main__':
    try:
        import psutil
    except ImportError:
        print("错误：需要安装psutil包，请运行pip install psutil", file=sys.stderr)
        sys.exit(1)
    
    raw = sys.stdin.read().strip()
    args = json.loads(raw) if raw else {}
    try:
        result = handler(args)
        print(result)
    except Exception as e:
        print(f"生成状态报告失败：{str(e)}", file=sys.stderr)
        sys.exit(1)