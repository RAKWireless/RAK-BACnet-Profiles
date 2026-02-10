# BACnet Profile 自动化生成 Agent

从 GitHub Issue 自动生成 BACnet Profile YAML 文件。

## 快速开始

### 1. 安装依赖

```bash
cd automation
pip install -r requirements.txt
```

### 2. 配置 API Keys

```bash
# 方法1: 环境变量
export QWEN_API_KEY="your_qwen_key"
export DEEPSEEK_API_KEY="your_deepseek_key"

# 方法2: .env 文件
cp .env.example .env
# 编辑 .env 填入你的 API Keys
```

### 3. 运行 Agent

```bash
# 使用测试数据
python scripts/run-agent.py \
    --issue-body-file test/test-issue-body.txt \
    --issue-number 1

# 使用自己的 Issue 文件
python scripts/run-agent.py \
    --issue-body-file path/to/your-issue.txt \
    --issue-number 123
```

### 4. 查看结果

生成的文件保存在：
- `profiles/{vendor}/{vendor}-{model}.yaml` - Profile 文件
- `profiles/{vendor}/tests/` - 测试数据和期望输出
- `automation/temp/run-{issue-number}-*/` - 日志和临时文件

## 前置要求

- Python 3.11+
- Node.js 18+ (用于验证脚本)
- Qwen API Key ([阿里云 DashScope](https://dashscope.aliyun.com/))
- DeepSeek API Key ([DeepSeek Platform](https://platform.deepseek.com/))

## 目录结构

```
automation/
├── scripts/
│   ├── run-agent.py          # 主程序入口
│   ├── validate-profiles.py  # 验证工具
│   ├── agent/                # 核心逻辑模块
│   │   ├── config.py         # 配置常量
│   │   ├── context.py        # 工作流上下文
│   │   ├── llm.py            # AI 模型调用
│   │   ├── nodes/            # 工作流节点
│   │   │   ├── parse.py      # 解析 Issue
│   │   │   ├── validate.py   # 验证 Profile
│   │   │   ├── test_gen.py   # 生成测试数据
│   │   │   ├── changelog.py  # 生成变更日志
│   │   │   └── merge.py      # 合并结果
│   │   ├── router.py         # 路由逻辑
│   │   └── workflow.py       # 工作流构建
│   └── tools/
│       └── parse_issue.py    # Issue 解析工具
├── skills/                   # AI Prompt 模板
│   ├── parse-issue/
│   ├── generate-profile/
│   ├── validate-profile/
│   ├── generate-tests/
│   └── generate-changelog/
├── test/                     # 测试数据
├── requirements.txt          # Python 依赖
└── docker-entrypoint.sh      # Docker 入口
```

## Docker 运行

```bash
# 构建镜像
docker build -t profile-agent .

# 运行 Agent
docker run --rm \
  -e QWEN_API_KEY \
  -e DEEPSEEK_API_KEY \
  -v $(pwd)/../:/workspace \
  profile-agent \
  --issue-body-file /workspace/test-issue-body.txt

# 验证所有 Profiles
docker run --rm \
  --entrypoint python \
  profile-agent \
  /workspace/automation/scripts/validate-profiles.py --all
```

## 工作流程

```
Issue Body → Parse → Generate Profile → Generate Tests → Validate → Changelog → Merge Results
                ↑                              ↓
                └──────────────── Retries (max 2) ─────────────────┘
```

1. **Parse**: 从 Issue 提取设备信息（厂商、型号、传感器等）
2. **Generate**: 使用 LLM 生成 Profile YAML（带智能模板选择）
3. **Test Gen**: 生成测试数据和期望输出
4. **Validate**: 验证 YAML 语法和 Codec 逻辑
5. **Retry**: 验证失败时自动重试（最多2次）
6. **Changelog**: 生成 CHANGELOG.md
7. **Merge**: 汇总结果，报告成功/失败

## 配置说明

### LLM 模型

- **主模型**: Qwen (qwen-turbo) - 阿里云 DashScope
- **备用模型**: DeepSeek (deepseek-chat) - Qwen 失败时自动降级

### 模板选择算法

根据设备特征匹配最佳模板：
- 设备类型匹配: 40% (water/air/climate/etc.)
- BACnet 对象类型: 30% (analog/binary)
- 传感器数量: 20%
- LoRaWAN 类别: 10%

## 常见问题

**Q: API Key 未设置错误**  
A: 确保已设置环境变量 `QWEN_API_KEY` 和 `DEEPSEEK_API_KEY`，或正确配置 `.env` 文件

**Q: 验证脚本失败**  
A: 确保 Node.js 已安装 (>= 18)，且 `scripts/` 目录包含 `validate-profile.js`

**Q: 生成的 Profile 验证失败**  
A: Agent 会自动重试最多 2 次。查看日志文件 `automation/temp/run-*/agent.log` 了解详细错误

**Q: 如何调试**  
A: 检查 `automation/temp/run-{issue-number}-{timestamp}/` 目录中的：
- `agent.log` - 完整执行日志
- `agent-result-{issue-number}.json` - 执行结果
- `generated-files-list.txt` - 生成的文件列表

## 开发说明

### 代码规范

- Clean Code 原则：单一职责、小函数、无全局状态
- 类型注解：所有函数都有类型提示
- 文档字符串：每个模块和函数都有详细注释

### 测试

```bash
# 验证所有现有 Profiles
python scripts/validate-profiles.py --all

# 测试特定 Profile
python scripts/validate-profiles.py profiles/Senso8/Senso8-LRS20100.yaml
```

## License

MIT

---

## 附录：阶段一实现记录

### 已创建的文件

```
automation/
├── skills/                          已创建
│   ├── parse-issue/
│   │   └── SKILL.md                解析 Issue body
│   ├── generate-profile/
│   │   └── SKILL.md                生成 Profile YAML
│   ├── validate-profile/
│   │   └── SKILL.md                验证 Profile
│   ├── generate-tests/
│   │   └── SKILL.md                生成测试数据（两阶段）
│   └── generate-changelog/
│       └── SKILL.md                生成变更日志
│
├── scripts/                         已创建
│   ├── run-agent.py                主程序（支持模型降级）
│   ├── validate-profiles.py        验证工具
│   ├── test-all-profiles.py        批量测试
│   └── tools/
│       └── parse_issue.py          Issue 解析工具
│
├── test/                            已创建
│   ├── test-issue-body.txt         英文测试 Issue
│   └── test-issue-body-zh.txt      中文测试 Issue
│
├── requirements.txt                 Python 依赖
├── .env.example                    环境变量示例
├── .gitignore                      Git 忽略规则
└── README.md                       使用说明（本文档）
```

### 核心功能

#### 1. Skills 实现
- **parse-issue**: 解析 GitHub Issue body（支持中英文、多设备）
- **generate-profile**: 生成 Profile YAML（支持幂等性、版本管理）
- **validate-profile**: 验证 Profile（调用现有验证脚本）
- **generate-tests**: 两阶段测试数据生成
- **generate-changelog**: 生成变更日志（Keep a Changelog 格式）

#### 2. Agent 主程序
- 支持 Qwen（主）+ DeepSeek（降级）
- 错误处理和模型切换
- Skills 自动加载
- LangGraph 工作流编排

#### 3. 测试支持
- 英文 Issue 测试用例
- 中文 Issue 测试用例
- 批量验证工具
