# Profile 测试数据完整指南

本指南介绍如何为 BACnet Profile 创建和维护测试数据（test fixture），验证 Codec 的上行解码，以及存在下行能力时的编码结果是否符合 BACnet 对象映射和已知协议向量。

---

## 📂 目录结构

每个 Profile 对应一个已提交的测试 fixture 文件：

```
profiles/
└── Vendor/
    ├── Vendor-Model.yaml          # Profile 文件
    └── tests/
        └── Vendor-Model.test.json # 测试 fixture（必需）
```

fixture 文件必须与所测试的 Profile 同名，例如 `Milesight-EM410-RDL.yaml` → `tests/Milesight-EM410-RDL.test.json`。

---

## 📋 测试 fixture 的作用

一个 `.test.json` fixture 同时包含某个 Profile 的测试输入和期望输出：

- **输入**：上行载荷（`fPort` + 十六进制 `input`）及其描述
- **期望输出**：每个载荷应解码出的 BACnet 行数组
- **下行向量**：BACnet `channel` + 数值 `value`、期望 fPort 和期望字节
- **元数据**：证据等级、数据来源、鲁棒性策略

验证器会对每个测试用例执行 Profile Codec，并检查：

1. 解码成功且结果确定（幂等）
2. 解码出的 `data` 数组与 `expectedOutput` 完全匹配（若提供）
3. 每个解码条目均符合 `datatype` 映射（channel、name、unit、value）
4. 所有非输出型 `datatype` 通道都被 fixture 覆盖
5. 鲁棒性：截断载荷和未知 fPort 能被正确拒绝（可配置）
6. 每条下行向量都能确定性编码为期望字节和 fPort

---

## 🔧 创建测试 fixture 的步骤

### 步骤 1: 创建测试目录

```bash
mkdir -p profiles/Vendor/tests
```

### 步骤 2: 创建 fixture 文件

创建 `profiles/Vendor/tests/Vendor-Model.test.json`：

```json
{
  "schemaVersion": 1,
  "profile": "Vendor-Model",
  "evidenceLevel": "known-answer",
  "reviewMode": "single-model",
  "sources": [
    {
      "type": "official-document",
      "reference": "Vendor-Model User Guide, payload section",
      "citation": "Periodic and alarm payload examples used as test vectors"
    }
  ],
  "robustness": {
    "checkTruncation": true,
    "checkUnknownFPort": true,
    "checkFuzz": false
  },
  "testCases": [
    {
      "name": "Normal periodic report",
      "fPort": 10,
      "input": "0175640500000482b3",
      "description": "Temperature=25.0C, Humidity=60%",
      "expectedOutput": [
        { "name": "Temperature", "channel": 1, "value": 25.0, "unit": "degreesCelsius" },
        { "name": "Humidity", "channel": 2, "value": 60, "unit": "percent" }
      ]
    },
    {
      "name": "High temperature alarm",
      "fPort": 10,
      "input": "0482c82701",
      "description": "Temperature alarm triggered",
      "expectedOutput": [
        { "name": "Temperature", "channel": 1, "value": 31.0, "unit": "degreesCelsius" },
        { "name": "High Temp Alarm", "channel": 3, "value": 1, "unit": null }
      ]
    }
  ]
}
```

---

## 📖 fixture 字段说明

### 顶层字段

| 字段 | 必需 | 说明 |
|------|------|------|
| `schemaVersion` | ✅ | Schema 版本，必须为 `1` |
| `profile` | ✅ | 必须与 YAML 文件名（不含扩展名）完全一致，如 `Milesight-EM410-RDL` |
| `evidenceLevel` | ✅ | `known-answer`、`documentation-only` 或 `decoder-derived`（见下文） |
| `reviewMode` | ❌ | `single-model`（默认）或 `multi-model` |
| `sources` | ✅ | 载荷的证据来源（至少一个） |
| `fPortPolicy` | ❌ | fPort 处理方式：`fixed`、`agnostic` 或 `ignored` |
| `robustness` | ❌ | 鲁棒性检查开关：`checkTruncation`、`checkUnknownFPort`、`checkFuzz` |
| `strict` | ❌ | 为 `true` 时启用更严格的契约检查（见下文） |
| `testCases` | ✅ | 测试用例数组（至少一个） |
| `downlinkTestCases` | ❌ | 严格 fixture 含可写 datatype 通道时必需 |

### evidenceLevel（证据等级）

| 值 | 含义 | 要求 |
|----|------|------|
| `known-answer` | 期望输出已由独立来源（官方文档、客户数据）验证 | 至少一个 `expectedOutput`；通道覆盖缺失是**错误** |
| `documentation-only` | 仅依据文档解析，无独立验证基准 | 覆盖缺失仅产生**警告** |
| `decoder-derived` | 期望输出由解码器自身产生 | 至少一个 `expectedOutput` |

### sources（数据来源）

```json
"source": {
  "type": "official-document",
  "reference": "Milesight EM410-RDL User Guide",
  "citation": "Periodic and alarm payload examples"
}
```

- `type`：`issue`、`official-document`、`vendor-decoder`、`customer-data` 之一
- `reference`（必需）：文档名称、URL 或 Issue 引用
- `citation`（可选）：测试向量的具体出处

### fPortPolicy（端口策略）

描述解码器如何处理 LoRaWAN fPort，会改变鲁棒性检查的行为：

```json
// 固定的一组已知端口
{ "mode": "fixed", "ports": [85, 86], "citation": "Port 85 for data, 86 for config" }

// 解码器忽略端口（任意应用端口解码结果相同）
{ "mode": "agnostic", "representativeFPort": 85, "citation": "Payloads are port-agnostic" }

// 该设备不使用 fPort 路由
{ "mode": "ignored", "representativeFPort": 85, "reason": "Device does not use fPort routing" }
```

### robustness（鲁棒性）

三个开关的默认行为如下：

| 字段 | 默认值 | 行为 |
|------|--------|------|
| `checkTruncation` | `true` | 将每个输入按多种长度截断；解码器必须返回 `errors` 数组且不产生 BACnet `data` |
| `checkUnknownFPort` | `true` | 用未使用的 fPort 运行输入；解码器必须返回 `errors` 数组且不产生 `data` |
| `checkFuzz` | `false` | 运行 16 个种子化模糊输入；输出必须确定且格式正确 |

### testCases（测试用例）

| 字段 | 必需 | 说明 |
|------|------|------|
| `name` | ✅ | 唯一的测试用例名称 |
| `messageType` | ❌ | 可选的类型标签，如 `periodic`、`alarm`、`boot` |
| `fPort` | ✅ | LoRaWAN 端口，整数 1–254 |
| `input` | ✅ | 十六进制上行载荷。允许空格和连字符（如 `"01 75 64 05"` 或 `"01-75-64-05"`） |
| `description` | ❌ | 载荷含义的人可读描述 |
| `expectedOutput` | ❌ | 期望解码出的 `data` 数组（见下文） |

### expectedOutput（期望输出）

`expectedOutput` 是数组，直接对应 `decodeUplink` 返回的 `data` 字段。每个条目包含四个字段：

```json
{ "name": "Temperature", "channel": 1, "value": 25.0, "unit": "degreesCelsius" }
```

- `name` — 必须与 Profile 中 `datatype.<channel>.name` 完全一致
- `channel` — 正整数，必须在 `datatype` 中声明
- `value` — 有限数字（SQLite REAL 存储）。整数值用整数，缩放值用浮点数
- `unit` — 必须是**规范 BACnet 单位名**（见允许列表），无单位的对象（如 `BinaryInputObject`）用 `null`

⚠️ 不要使用 `"°C"`、`"%"` 这类显示单位，请使用规范名称：

| 测量量 | 规范单位名 |
|--------|-----------|
| 温度 | `degreesCelsius` |
| 湿度（RH） | `percent` 或 `percentRelativeHumidity` |
| 电池 / 百分比 | `percent` |
| 距离 | `millimeters` |
| 气体浓度 | `partsPerMillion` |
| 信号强度 | `decibels` |
| 电压 | `millivolts` |
| 光照强度 | `luxes` |
| 无单位（二进制/状态） | `null` |

完整允许单位列表在 `scripts/lib/units.js`（`ALLOWED_UNITS`）。`expectedOutput` 中的单位必须与 `datatype.<channel>.units` 一致。

### downlinkTestCases（下行测试用例）

```json
{
  "name": "Close Valve",
  "channel": 10,
  "value": 1,
  "expectedFPort": 5,
  "expectedBytes": "73 01",
  "citation": "Issue #38 Downlink Command Examples"
}
```

- `channel` 和 `value` 会传给 `Encode`。
- `expectedFPort` 必须等于可写 datatype 对象的 `fport`，范围为 1–254。
- `expectedBytes` 是来自已知载荷或完整官方协议文档的精确十六进制基准。
- 严格 fixture 必须覆盖所有可写 datatype 通道；未知 channel 和非数值 value 必须返回空 `bytes` 与非空 `errors`，以失败关闭。
- 通过该检查只能证明 Codec 编码符合证据，不能证明设备实际动作；实机验证仍需人工完成。

---

## 🔍 运行验证

### 步骤 3: 交互式解码单个载荷

```bash
node scripts/test-codec.js \
  -f profiles/Vendor/Vendor-Model.yaml \
  -p 10 \
  -u 0175640500000482b3
```

输出会显示解码出的 `data` 数组，可据此填写 `expectedOutput`（需先独立确认其正确性）。

### 步骤 4: 验证单个 Profile 及其 fixture

```bash
node scripts/run-profile-ci.js \
  profiles/Vendor/Vendor-Model.yaml \
  --fixture profiles/Vendor/tests/Vendor-Model.test.json
```

`run-profile-ci.js` 是 Profile Automation 工作流使用的严格 CI 入口，依次执行：

- YAML 语法、JSON Schema、必填字段
- Codec 静态安全检查与语法
- BACnet 对象配置与文件命名
- Profile 语义（datatype 字段顺序、单位、映射规则）
- 完整 fixture 执行

每项检查输出 `PASS` 或 `FAIL`，并给出详细错误信息。

### 步骤 5: 验证所有已提交的 fixture

```bash
node scripts/validate-committed-fixtures.js
```

该命令会查找 `profiles/` 下所有 `*.test.json`，与对应 Profile 配对并验证。它是仓库必需的检查之一：

```bash
node scripts/validate-all.js                  # 所有 Profile YAML 文件（基础检查）
node scripts/validate-committed-fixtures.js   # 所有已提交的测试 fixture
node scripts/validate-registry.js             # registry.json
node scripts/test-profile-automation.js       # 自动化回归测试
```

---

## ✅ fixture 验证器检查内容

对每个测试用例，验证器会：

1. **运行两次解码器**，要求输出一致（确定性）
2. **深度比对 `data` 数组**与 `expectedOutput`（数组顺序敏感，对象键顺序不敏感）
3. **校验每个解码条目**：
   - `channel` 是在 `datatype` 中声明的正整数
   - 单次解码结果中无重复 channel
   - `name` 等于 `datatype.<channel>.name`
   - `unit` 等于 `datatype.<channel>.units`（或 `null`）
   - `value` 是有限数字
4. **检查通道覆盖**：所有非输出型 `datatype` 通道必须至少在一条测试结果中出现。`known-answer`/`decoder-derived` 缺失为错误，`documentation-only` 缺失仅警告
5. **按 `robustness` 和 `fPortPolicy` 执行鲁棒性检查**
6. **每条 downlink 用例运行两次**，检查精确字节和 fPort，并要求严格 fixture 覆盖所有可写通道

对 `strict: true` 的 fixture 还有额外契约：
- BinaryInputObject 的值必须恰好是 `0` 或 `1`
- 成功时解码器必须省略 `errors`；失败时返回非空字符串数组且不返回 `data`

---

## ⚠️ 常见错误和解决方案

### 错误 1: fixture 的 profile 不匹配

```
Fixture profile 'Vendor-Model' must equal 'Vendor-ModelX'
```

`profile` 字段必须与 YAML 文件名（不含扩展名）完全一致。

### 错误 2: 单位不匹配

```
Channel 1 unit '°C' does not match datatype unit 'degreesCelsius'
```

请使用 `scripts/lib/units.js` 中的规范 BACnet 单位名，不允许 `°C`、`%` 等显示字符串。

### 错误 3: known-answer fixture 没有 expectedOutput

```
known-answer fixtures must contain at least one expectedOutput
```

`known-answer` 和 `decoder-derived` 必须包含期望输出，只有 `documentation-only` 可以省略。

### 错误 4: 解码出的通道未在 datatype 中声明

```
Decoded channel 9 is not declared in datatype
```

解码器输出的每个条目都必须映射到 Profile `datatype` 中声明的通道。请补充通道或修正解码器。

### 错误 5: 通道覆盖缺失

```
Test fixtures do not cover datatype channels: 4, 5
```

请添加能产生这些通道的测试用例；`documentation-only` 可以接受警告。

### 错误 6: 截断 / 未知 fPort 鲁棒性检查失败

```
truncated length 4: decoder must return an errors array
```

解码器必须以 `{ data: [], errors: ["..."] }`（或 `{ errors: [...] }`）优雅地拒绝无效输入，而不是抛异常或返回部分数据。`fPortPolicy` 决定哪些 fPort 视为合法。

### 错误 7: 实际输出与 expectedOutput 不一致

```
Test case 'X': Actual output does not match expectedOutput
```

用 `test-codec.js` 重新解码载荷，确认正确数值后更新 `expectedOutput`。注意 JSON 中 `25` 与 `25.0` 等价，但数组其余部分必须完全一致，且数组元素顺序必须相同。

---

## 🏢 多型号管理

测试用例中不再有 `model` 字段。每个 fixture 通过 `profile` 字段和文件名绑定到唯一一个 Profile。厂商有多个型号时，为每个型号各建一个 fixture：

```
profiles/Senso8/
├── Senso8-LRS20100.yaml
├── Senso8-LRS20200.yaml
├── Senso8-LRS20600.yaml
└── tests/
    ├── Senso8-LRS20100.test.json
    ├── Senso8-LRS20200.test.json
    └── Senso8-LRS20600.test.json
```

如果这些型号共享同一协议族，可在各 fixture 中设置 `reviewMode: "multi-model"`。

---

## 🎯 最佳实践

### 1. 覆盖所有通道

验证器要求所有非输出型 `datatype` 通道至少在一条测试用例中出现。请规划测试用例，让每个通道（包括告警/状态通道）至少被产生一次。

### 2. 使用真实载荷

优先使用来自真实设备、官方文档或请求 Issue 的载荷。在 `sources` 中用 `type`、`reference`、`citation` 标注每个向量的出处。

### 3. 设置正确的 evidenceLevel

- 期望值经独立确认时才用 `known-answer`
- 仅依据文档解析时用 `documentation-only`
- 由被审查解码器自身产生输出时用 `decoder-derived`

### 4. 单位保持规范

`expectedOutput` 中不要使用显示单位。从 `datatype` 复制单位（`degreesCelsius`、`percent`、`partsPerMillion`、`millimeters` 等），无单位对象使用 `null`。

### 5. 写清晰的描述

```json
{
  "name": "Low temperature alarm",
  "fPort": 10,
  "input": "0801640100000000ffdc",
  "description": "Temperature=-5C, triggers low temperature alarm, battery=100%"
}
```

### 6. 每次修改 Codec 后运行验证

```bash
node scripts/run-profile-ci.js \
  profiles/Vendor/Vendor-Model.yaml \
  --fixture profiles/Vendor/tests/Vendor-Model.test.json
node scripts/validate-committed-fixtures.js
```

---

## 🛠️ 调试技巧

### 检查单个载荷

```bash
node scripts/test-codec.js -f profiles/Vendor/Vendor-Model.yaml -p 10 -u 0175640500000482b3
```

### 对现有数据文件批量测试

`test-codec.js` 支持针对 JSON 测试数据文件的批量模式：

```bash
node scripts/test-codec.js --batch profiles/Vendor/Vendor-Model.yaml \
  examples/minimal-profile/tests/test-data.json
```

### 校验 JSON 语法

```bash
jq . profiles/Vendor/tests/Vendor-Model.test.json
```

---

## ✅ 检查清单

提交 Profile 前确认：

- [ ] 已在 Profile 旁创建 `tests/Vendor-Model.test.json`
- [ ] `schemaVersion: 1`，且 `profile` 与 YAML 文件名一致
- [ ] `evidenceLevel` 和 `sources` 说明了向量的来源
- [ ] 至少包含一个 `expectedOutput`（`documentation-only` 除外）
- [ ] 所有非输出型 `datatype` 通道至少被一条测试用例覆盖
- [ ] `expectedOutput` 使用与 `datatype` 一致的规范 BACnet 单位
- [ ] 存在可写 datatype 通道时，`downlinkTestCases` 覆盖每个可写通道
- [ ] `node scripts/run-profile-ci.js` 对 Profile 及其 fixture 通过
- [ ] `node scripts/validate-committed-fixtures.js` 通过

---

## 📚 完整示例

仓库中已提交的真实 fixture：

- `profiles/Milesight/tests/Milesight-EM410-RDL.test.json`
- `profiles/Milesight/tests/Milesight-WT304.test.json`
- `profiles/QingPing/tests/QingPing-CGP22CLH.test.json`
- `profiles/Thermokon/tests/Thermokon-NOVOS3-OccLumCO2TempRH.test.json`
- `profiles/Eddy-Solutions/tests/Eddy-Solutions-LoRa-IQ-V2.test.json`（含 Issue #38 downlink 向量）

---

**最后更新**: 2026-08-28
