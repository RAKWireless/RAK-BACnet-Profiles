# 标准完整 Profile 示例

这是一个生产级的完整 Profile 示例，展示了多传感器设备的配置方法。

## 📋 示例说明

**设备类型：** 温湿度传感器（带电池监测和报警功能）  
**功能：** 
- 温度、湿度监测
- 电池电量监测
- 高低温报警
- 高低湿度报警
- 按钮事件检测

**复杂度：** ⭐⭐⭐ 中等

## 🎯 学习目标

通过这个示例，您将学会：
1. 如何处理多个传感器参数
2. 如何使用不同的 BACnet 对象类型
3. 如何处理不同的 fPort 消息
4. 如何配置 COV 和更新间隔
5. 如何处理位域数据（Bit Field）

## 📦 文件说明

```
standard-profile/
├── README.md                           # 本文件
├── standard-temp-humidity-sensor.yaml  # Profile 配置文件
└── tests/
    ├── test-data.json                 # 测试数据
    └── expected-output.json           # 期望输出
```

## 🔍 关键知识点

### 1. 多传感器数据解析

```javascript
// 同时解析多个参数
var temperature = view.getInt16(3, false) / 10.0;  // 温度
var humidity = view.getUint16(5, false) / 10.0;    // 湿度
var battery = data[2];                              // 电池电量
```

### 2. 位域解析（Bit Field）

```javascript
// 从一个字节中提取多个布尔值
var byte0 = data[0];
var humidityLowAlert = (byte0 >> 5) & 0x01;      // 第5位
var humidityHighAlert = (byte0 >> 4) & 0x01;     // 第4位
var temperatureLowAlert = (byte0 >> 3) & 0x01;   // 第3位
var temperatureHighAlert = (byte0 >> 2) & 0x01;  // 第2位
var buttonPressed = byte0 & 0x01;                // 第0位
```

### 3. 多种 BACnet 对象类型

```yaml
datatype:
  "1":
    type: AnalogInputObject    # 模拟输入 - 温度传感器
  "4":
    type: BinaryInputObject    # 二值输入 - 报警状态
```

### 4. 处理不同的 fPort

```javascript
if (fPort == 10) {
  // 传感器数据
}
if (fPort == 12) {
  // 配置信息
}
if (fPort == 13) {
  // 阈值设置
}
```

## 📊 数据格式说明

### fPort 10 - 传感器数据（7字节）

| Byte | 说明 | 数据类型 |
|------|------|---------|
| 0 | 状态标志位 | 位域 |
| 1 | 保留 | - |
| 2 | 电池电量 (%) | uint8 |
| 3-4 | 温度 (°C * 10) | int16 (大端) |
| 5-6 | 湿度 (% * 10) | uint16 (大端) |

**状态标志位（Byte 0）：**
```
Bit 7-6: 保留
Bit 5: 湿度低报警
Bit 4: 湿度高报警
Bit 3: 温度低报警
Bit 2: 温度高报警
Bit 1: 保留
Bit 0: 按钮按下
```

### fPort 12 - 配置信息（3字节）

| Byte | 说明 | 数据类型 |
|------|------|---------|
| 0 | 命令类型 (0x01) | uint8 |
| 1-2 | 上报间隔 (秒) | uint16 (大端) |

### fPort 13 - 阈值配置（6字节）

| Byte | 说明 | 数据类型 |
|------|------|---------|
| 0 | 命令类型 (0x02) | uint8 |
| 1-2 | 温度高阈值 (°C) | int16 (大端) |
| 3-4 | 温度低阈值 (°C) | int16 (大端) |
| 5 | 湿度高阈值 (%) | uint8 |
| 6 | 湿度低阈值 (%) | uint8 |

## 🧪 测试数据

查看 `tests/` 目录了解完整的测试用例，包括：
- 正常数据场景
- 报警触发场景
- 边界值测试
- 配置查询响应

## 💡 高级技巧

### 1. COV 增量设置

```yaml
covIncrement: 0.1    # 温度变化 0.1°C 触发通知
covIncrement: 1.0    # 湿度变化 1% 触发通知
```

根据传感器精度和实际需求调整。

### 2. 更新间隔设置

```yaml
updateInterval: 600   # 10分钟更新一次
```

通常设置为设备的实际上报周期。

### 3. 数据验证

在 Codec 中添加数据验证逻辑：
```javascript
// 温度范围检查
if (temperature < -40 || temperature > 85) {
  // 数据异常，可能需要记录或跳过
}
```

## 📝 如何基于此示例创建 Profile

### 步骤 1: 分析您的设备数据格式
- 获取数据手册
- 记录每个字节的含义
- 确认字节序（大端/小端）

### 步骤 2: 复制并修改
```bash
cp examples/standard-profile/standard-temp-humidity-sensor.yaml profiles/YourVendor/YourVendor-Model.yaml
```

### 步骤 3: 修改 Codec 函数
- 根据实际数据格式调整解析逻辑
- 添加或删除传感器参数
- 调整数据换算系数

### 步骤 4: 配置 BACnet 对象
- 为每个参数选择合适的对象类型
- 设置正确的单位
- 配置 COV 和更新间隔

### 步骤 5: 准备测试数据
- 使用真实设备采集测试数据
- 创建多种场景的测试用例
- 验证解码结果的正确性

## ⚠️ 常见陷阱

1. **字节序错误** - 混淆大端和小端
2. **Channel 重复** - 确保每个 channel 唯一
3. **单位不匹配** - Codec 中的单位换算要与 BACnet 单位对应
4. **fPort 遗漏** - 忘记处理某些 fPort 的数据
5. **位操作错误** - 位移和掩码操作要仔细验证

## 🔽 下行控制

如果设备支持下行命令（如设置目标值或控制继电器），需要在 Codec 中添加 `Encode` 函数，并在 `datatype` 中定义 Output 类型的 BACnet 对象。

### 1. Encode 函数

每当 BMS 向可写 BACnet 对象写入数值时，网关会调用 `Encode(data, variables)`：

```javascript
function Encode(data, variables) {
    // data.channel : 被 BMS 写入的 BACnet Output 对象所对应的通道号
    // data.value   : BMS 写入该对象的数值
    var channel = data.channel;
    var value = data.value;
    var bytes = [];

    // 示例：通道 11 = "设置温度设定值"
    if (channel === 11) {
        bytes.push(0x01);           // 命令类型
        bytes.push(value & 0xFF);   // 数值低字节
    }
    // 根据需要添加更多通道逻辑 ...

    return bytes;
}

function encodeDownlink(input) {
    return { bytes: Encode(input.data, input.variables) };
}
```

### 2. datatype 中的 Output 对象

每个可控通道需要定义一个带有 `fport` 字段的 Output/Value 类型 BACnet 对象：

```yaml
datatype:
  # ... 上行对象（AnalogInputObject、BinaryInputObject 等）...

  "11":
    name: Set Temperature Setpoint
    type: AnalogOutputObject    # BMS 可写
    units: degreesCelsius
    updateInterval: 60
    fport: 85                   # 下行帧使用的 LoRaWAN fPort
    channel: 11                 # 传入 Encode 的 data.channel
```

### 3. 下行控制端到端流程

```
BMS 向 BACnet 对象写入数值（AnalogOutputObject，通道 11）
    ↓
网关调用 Encode({ channel: 11, value: 22.5 })
    ↓
Encode 构建设备专用字节数组
    ↓
网关通过 fport: 85 发送 LoRaWAN 下行帧
    ↓
设备接收并应用新的设定值
```

> **参考：** 查看 `profiles/Becasmart/Becasmart-BAC006.yaml`，这是一个包含多个可控通道的完整双向通信 Profile 真实案例。

## 🚀 进阶学习

掌握本示例后，可以：
1. 查看仓库中真实的 Profile 文件
2. 参考 `profiles/Becasmart/Becasmart-BAC006.yaml` 学习完整的下行控制实现
3. 了解更复杂的数据格式（如 TLV、Protocol Buffers）

---

**提示**: 建议结合真实设备的数据手册学习本示例，效果更佳！

