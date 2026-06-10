# RAK7437 BACnet 配置文件

[English](README.md) | [中文](README.zh-CN.md)

用于 RAKwireless 网关的 LoRaWAN 设备 BACnet 配置文件仓库。该仓库包含多个厂商的 LoRaWAN 传感器/执行器到 BACnet 对象的映射配置文件。

## 📋 目录

- [简介](#简介)
- [项目结构](#项目结构)
- [配置文件格式](#配置文件格式)
- [使用方法](#使用方法)
- [贡献指南](#贡献指南)

## 📖 简介

本仓库提供了 LoRaWAN 设备到 BACnet 协议的转换配置文件。这些配置文件（Profile）使 RAK 网关能够将 LoRaWAN 设备的数据映射为标准的 BACnet 对象（如模拟输入、二进制输入、模拟输出等），从而实现与楼宇管理系统（BMS）的无缝集成。

### 主要特性

- 🔄 支持 LoRaWAN 数据的自动编解码
- 📊 将 LoRaWAN 数据映射到标准 BACnet 对象
- 🏢 支持多种楼宇传感器和执行器
- ⚙️ 可配置的对象属性（更新间隔、COV 增量等）
- 🔌 支持双向通信（读取传感器数据和控制执行器）

## 📁 项目结构

```
RAK-BACnet-Profiles/
├── profiles/                   # 真实设备 Profile 配置
│   ├── Becasmart/             # Becasmart 设备
│   ├── Dragino/               # Dragino 设备
│   ├── Milesight/             # Milesight 设备
│   ├── RAKwireless/           # RAKwireless 设备
│   └── Senso8/                # Senso8 设备
│       ├── *.yaml             # Profile 文件
│       └── tests/             # 测试数据（可选）
├── examples/                  # 示例 Profile
│   ├── minimal-profile/       # 最小示例
│   └── standard-profile/      # 完整示例
├── scripts/                   # 验证脚本
│   ├── validate-profile.js    # Profile 验证器
│   ├── test-codec.js          # Codec 测试器
│   └── utils/                 # 工具函数
├── docs/                      # 文档
├── .github/                   # GitHub 模板
├── registry.json              # Profile 注册表 🆕
├── registry-schema.json       # 注册表 Schema
└── README.md
```

## 📚 Profile 注册表

项目包含一个自动生成的 `registry.json` 文件，提供所有可用 Profile 的索引和统计信息。

### 注册表内容

```json
{
  "version": "1.0.0",
  "lastUpdate": "2026-01-16",
  "totalProfiles": 19,
  "profiles": [
    {
      "id": "senso8-lrs20310",
      "vendor": "Senso8",
      "model": "LRS20310",
      "version": "1.0.0",
      "path": "profiles/Senso8/Senso8-LRS20310.yaml",
      "verified": true,
      "hasTests": true,
      "description": "Senso8 LRS20310 Water Leak Detection Sensor",
      "deviceType": "Water Leak Sensor",
      "lorawanClass": ["A"],
      "lastUpdate": "2026-01-16"
    }
  ],
  "statistics": {
    "byVendor": { "Senso8": 9, "Dragino": 4, "Carrier": 2, ... },
    "withTests": 10,
    "withoutTests": 9
  }
}
```

### 更新注册表

添加或修改 Profile 后，运行以下命令更新注册表：

```bash
cd scripts
node update-registry.js
```

## 📝 配置文件格式

每个 YAML 配置文件包含以下主要部分：

### 1. Codec（编解码器）

定义 LoRaWAN 数据的编码和解码函数（JavaScript）：

```yaml
codec: |
  function Decode(fPort, data, variables) {
    // 解码 LoRaWAN 上行数据
    var values = [];
    // ... 解析数据并填充 values 数组
    return values;
  }

  function Encode(data, variables) {
    // 编码 LoRaWAN 下行数据
    // data.channel : 被 BMS 写入的 BACnet Output 对象所对应的通道号
    // data.value   : BMS 写入该 BACnet Output 对象的数值
    var channel = data.channel;
    var value = data.value;
    var bytes = [];
    // ... 根据 channel 和 value 构建下行字节数组
    return bytes;
  }

  function decodeUplink(input) {
    return { data: Decode(input.fPort, input.bytes, input.variables) };
  }

  function encodeDownlink(input) {
    return { bytes: Encode(input.data, input.variables) };
  }
```

> **注意：** 只有当设备支持下行控制时（即 Profile 中包含 `AnalogOutputObject`、`BinaryOutputObject` 等 Output/Value 类型对象），才需要实现 `Encode` 函数。传入 `Encode` 的 `data` 对象始终包含 `channel`（通道号）和 `value`（写入值）两个属性。

### 2. Datatype（BACnet 对象定义）

定义 BACnet 对象的类型、属性和映射关系：

```yaml
datatype:
  # --- 上行（传感器读数）---
  "1":                              # 通道 ID（与 Decode 返回的 channel 对应）
    name: Temperature               # BACnet 对象名称
    type: AnalogInputObject         # BACnet 对象类型
    units: degreesCelsius           # 单位
    covIncrement: 0.1               # COV 增量
    updateInterval: 600             # 更新间隔（秒）
    channel: 1                      # LoRaWAN 通道号

  # --- 下行（执行器 / 控制）---
  "11":                             # 通道 ID（作为 data.channel 传入 Encode）
    name: Set Temperature           # BACnet 对象名称
    type: AnalogOutputObject        # Output 对象 —— BMS 可写
    units: degreesCelsius
    updateInterval: 60
    fport: 85                       # 下行帧使用的 LoRaWAN fPort
    channel: 11                     # 传入 Encode 的 data.channel
```

`fport` 字段对所有支持下行控制的对象（`AnalogOutputObject`、`BinaryOutputObject`、`AnalogValueObject`、`BinaryValueObject`）均为**必填项**。当 BMS 向 BACnet 对象写入数值时，网关会调用 `Encode({ channel, value })`，并将返回的字节数组通过指定的 `fport` 发送给设备。

**支持的 BACnet 对象类型：**
- `AnalogInputObject` - 模拟输入（传感器读数）
- `AnalogOutputObject` - 模拟输出（可控制的模拟值）
- `AnalogValueObject` - 模拟值（通用模拟量）
- `BinaryInputObject` - 二值输入（开关状态、报警等）
- `BinaryOutputObject` - 二值输出（可控制的开关）
- `BinaryValueObject` - 二值变量（通用二值）
- `OctetStringValueObject` - 字节串值（字符串、特殊数据）

### 3. LoRaWAN 配置

定义 LoRaWAN 相关参数：

```yaml
lorawan:
  adrAlgorithm: LoRa Only           # ADR 算法
  classCDownlinkTimeout: 5          # Class C 下行超时
  macVersion: LORAWAN_1_0_3         # LoRaWAN MAC 版本
  regionalParametersRevision: A      # 区域参数版本
  supportClassB: false              # 是否支持 Class B
  supportClassC: false              # 是否支持 Class C
  supportOTAA: true                 # 是否支持 OTAA 入网
```

### 4. 元数据

设备基本信息：

```yaml
model: Senso8-LRS20310              # 设备型号
profileVersion: 1.0.0               # Profile 版本
name: LRS20310                      # 设备名称
vendor: RAKwireless                 # 厂商名称
id: uuid-string                     # 唯一标识符（可选）
```

## 🚀 使用方法

### 1. 导入配置文件

将对应设备的 YAML 配置文件导入到 RAK 网关的 BACnet 服务中。

### 2. 设备入网

确保 LoRaWAN 设备已成功入网到 RAK 网关（支持 OTAA 或 ABP 方式）。

### 3. BACnet 对象映射

网关会根据配置文件自动创建对应的 BACnet 对象，并将 LoRaWAN 数据映射到这些对象上。

### 4. BMS 系统集成

在楼宇管理系统（BMS）中，通过标准 BACnet 协议访问这些对象，实现设备监控和控制。

### 示例：读取温度数据

```
设备上行数据（LoRaWAN）
    ↓
Decode 函数解析
    ↓
映射到 BACnet 对象（AnalogInputObject）
    ↓
BMS 系统读取（通过 BACnet 协议）
```

### 示例：控制空调

```
BMS 系统写入命令（通过 BACnet 协议）
    ↓
BACnet 对象接收（AnalogOutputObject）
    ↓
Encode 函数编码
    ↓
下行数据发送（LoRaWAN）
```

## 🤝 贡献指南

欢迎为本仓库贡献新的设备配置文件！

### 添加新设备配置

1. **Fork 本仓库**

2. **创建设备配置文件**
   - 在 `profiles/` 下对应厂商目录中创建新的 YAML 文件
   - 如果是新厂商，请在 `profiles/` 下创建新的厂商目录
   - 文件命名格式：`厂商-型号.yaml`
   - 示例：`profiles/YourVendor/YourVendor-Model.yaml`

3. **编写配置文件**
   - 实现 Decode 和 Encode 函数
   - 定义 BACnet 对象映射
   - 配置 LoRaWAN 参数
   - 添加完整的元数据信息

4. **测试验证**
   
   为 Profile 创建测试数据：
   
   ```bash
   # 创建测试目录
   mkdir -p profiles/YourVendor/tests
   
   # 添加测试输入数据
   # 创建 profiles/YourVendor/tests/test-data.json
   # 创建 profiles/YourVendor/tests/expected-output.json
   ```
   
   运行验证：
   
   ```bash
   # 安装依赖（首次运行）
   cd scripts && npm install && cd ..
   
   # 运行完整验证（包括输出验证）
   node scripts/validate-profile.js profiles/YourVendor/YourVendor-Model.yaml
   ```
   
   确保所有测试通过：
   - ✅ YAML 语法正确
   - ✅ Profile 结构完整
   - ✅ Codec 函数可执行
   - ✅ BACnet 对象类型支持
   - ✅ 测试数据解码成功
   - ✅ 输出匹配期望结果 `[输出匹配]`
   
   详细测试说明请参考 [docs/TESTING-GUIDE.md](docs/TESTING-GUIDE.md)。

5. **提交 Pull Request**
   - 提供设备的详细说明
   - 包含测试数据和期望输出
   - 确保验证通过
   - 更新本 README 中的设备列表

### 配置文件规范

- 使用标准 YAML 格式
- 代码注释清晰（JavaScript 函数）
- 对象命名符合 BACnet 规范
- 单位使用标准 BACnet 单位枚举
- 提供完整的元数据信息

## 📄 许可证

本项目中的配置文件供 RAKwireless 生态系统使用。

## 📧 联系方式

如有问题或建议，请通过以下方式联系：

- 提交 GitHub Issue
- 访问 [RAKwireless 官网](https://www.rakwireless.com/)
- 访问 [RAKwireless 论坛](https://forum.rakwireless.com/)


---

**注意：** 使用这些配置文件前，请确保您的 RAK 网关固件版本支持 BACnet 功能。具体支持情况请参考产品文档。

