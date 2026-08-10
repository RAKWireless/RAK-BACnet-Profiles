# Profile 工具脚本

所有验证和测试程序都是 `scripts/` 下的 Node.js 文件。对外命令保留在目录根部；可复用实现放在 `lib/`；纯数据验证定义放在 `schemas/`。

## 目录结构

```text
scripts/
├── evaluate-shadow-run.js       # 评估 Shadow 测试的 85% 目标
├── generate-expected-output.js  # 生成 Codec 预期输出
├── run-profile-ci.js            # 新 Profile 严格 CI 入口
├── test-profile-automation.js        # Profile Automation 回归测试
├── test-codec.js                # 单条及批量 Codec 测试
├── update-registry.js           # 重新生成 registry.json
├── validate-all.js              # 验证全部 Profile
├── validate-committed-fixtures.js
├── validate-profile.js          # 验证单个 Profile
├── validate-registry.js         # 验证 registry.json
├── lib/
│   ├── codec-sandbox.js
│   ├── hex-converter.js
│   ├── units.js
│   ├── yaml-parser.js
│   └── validation/              # 可复用验证模块
└── schemas/                     # JSON Schema 与 BACnet 映射规则
```

`lib/` 下的文件属于内部模块。工作流和用户文档应调用根目录命令，不应直接依赖内部模块路径。

## 安装依赖

在仓库根目录执行：

```bash
npm ci --prefix scripts
```

## 常用命令

运行完整的本地 CI：

```bash
npm run ci --prefix scripts
```

验证所有 Profile：

```bash
node scripts/validate-all.js
```

验证单个 Profile：

```bash
node scripts/validate-profile.js profiles/Vendor/Vendor-Model.yaml
```

使用提交的 Fixture 严格验证新 Profile：

```bash
node scripts/run-profile-ci.js \
  profiles/Vendor/Vendor-Model.yaml \
  --fixture profiles/Vendor/tests/Vendor-Model.test.json
```

测试一条 Codec Payload：

```bash
node scripts/test-codec.js \
  --file profiles/Vendor/Vendor-Model.yaml \
  --port 10 \
  --uplink 01020304
```

重新生成并验证 Registry：

```bash
node scripts/update-registry.js
node scripts/validate-registry.js
```

## npm 命令

| 命令 | 用途 |
|---|---|
| `npm test --prefix scripts` | 运行 Profile Automation 回归测试 |
| `npm run test:codec --prefix scripts -- ...` | 运行 Codec 命令行工具 |
| `npm run test:fixtures --prefix scripts` | 验证已提交的 `.test.json` Fixture |
| `npm run validate:all --prefix scripts` | 验证全部 Profile YAML |
| `npm run validate:registry --prefix scripts` | 验证 `registry.json` |
| `npm run registry:update --prefix scripts` | 重新生成 `registry.json` |
| `npm run ci --prefix scripts` | 运行标准本地 CI |

## 约定

- 新增的可执行测试和验证程序必须是 `scripts/` 下的 `.js` 文件。
- 稳定的用户命令保留在 `scripts/` 根目录。
- 共用实现放入 `scripts/lib/`，验证定义放入 `scripts/schemas/`。
- Fixture 只保存数据，位置为 `profiles/<Vendor>/tests/*.test.json`。
- 生成的 Codec 必须通过 `run-profile-ci.js` 执行，它会进行静态检查并使用受限运行环境。
