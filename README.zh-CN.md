# RAK BACnet 配置文件

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
├── Carrier/                    # 开利品牌设备配置
│   ├── Carrier-BAC-006-v4-20250709.yaml
│   └── 7201_V2_modify_0619.yaml
├── Dragino/                    # Dragino 品牌设备配置
│   ├── Dragino-LDS02.yaml     # 门磁传感器
│   └── Dragino-LES01.yaml     # 门窗传感器
├── Senso8/                     # Senso8 品牌设备配置
│   ├── Senso8-LRS10701.yaml
│   ├── Senso8-LRS20100.yaml
│   ├── Senso8-LRS20200.yaml
│   ├── Senso8-LRS20310.yaml   # 水浸传感器
│   ├── Senso8-LRS20600.yaml
│   ├── Senso8-LRS20LD0.yaml
│   ├── Senso8-LRS20Uxx.yaml
│   ├── Senso8-LRS2M001.yaml
│   └── Senso8-LRS30100.yaml   # 多功能环境传感器
└── README.md
```

## 📝 配置文件格式

每个 YAML 配置文件包含以下主要部分：

### 1. Codec（编解码器）

定义 LoRaWAN 数据的编码和解码函数（JavaScript）：

```yaml
codec: >
  function Decode(fPort, data, variables) {
    // 解码 LoRaWAN 上行数据
    var values = [];
    // ... 解析数据并填充 values 数组
    return values;
  }

  function Encode(data, variables) {
    // 编码 LoRaWAN 下行数据
    var bytes = [];
    // ... 编码数据
    return bytes;
  }
```

### 2. Datatype（BACnet 对象定义）

定义 BACnet 对象的类型、属性和映射关系：

```yaml
datatype:
  "1":                              # 通道 ID
    name: Temperature               # 对象名称
    type: AnalogInputObject         # BACnet 对象类型
    units: degreesCelsius          # 单位
    covIncrement: 0.1              # COV 增量
    updateInterval: 600            # 更新间隔（秒）
    channel: 1                     # LoRaWAN 通道号
```

**支持的 BACnet 对象类型：**
- `AnalogInputObject` - 模拟输入（传感器读数）
- `AnalogOutputObject` - 模拟输出（可控制的模拟值）
- `BinaryInputObject` - 二进制输入（开关状态）
- `BinaryOutputObject` - 二进制输出（可控制的开关）
- `OctetStringValueObject` - 字节串值对象

### 3. LoRaWAN 配置

定义 LoRaWAN 相关参数：

```yaml
lorawan:
  adrAlgorithm: LoRa Only           # ADR 算法
  classCDownlinkTimeout: 5          # Class C 下行超时
  macVersion: LORAWAN_1_0_3         # LoRaWAN MAC 版本
  region: AS923                      # 区域频段
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
   - 在对应厂商目录下创建新的 YAML 文件
   - 如果是新厂商，请创建新的厂商目录
   - 文件命名格式：`厂商-型号.yaml`

3. **编写配置文件**
   - 实现 Decode 和 Encode 函数
   - 定义 BACnet 对象映射
   - 配置 LoRaWAN 参数
   - 添加完整的元数据信息

4. **测试验证**
   - 在实际设备上测试配置文件
   - 验证数据编解码的正确性
   - 确认 BACnet 对象映射正常工作

5. **提交 Pull Request**
   - 提供设备的详细说明
   - 包含测试结果和使用场景
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

