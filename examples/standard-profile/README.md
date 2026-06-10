# Standard Complete Profile Example

This is a production-grade complete Profile example demonstrating the configuration method for multi-sensor devices.

## 📋 Example Description

**Device Type:** Temperature & Humidity Sensor (with battery monitoring and alarm functions)  
**Functions:** 
- Temperature and humidity monitoring
- Battery level monitoring
- High/low temperature alarms
- High/low humidity alarms
- Button event detection

**Complexity:** ⭐⭐⭐ Medium

## 🎯 Learning Objectives

Through this example, you will learn:
1. How to handle multiple sensor parameters
2. How to use different BACnet object types
3. How to handle different fPort messages
4. How to configure COV and update intervals
5. How to handle bit field data

## 📦 File Description

```
standard-profile/
├── README.md                           # This file
├── standard-temp-humidity-sensor.yaml  # Profile configuration file
└── tests/
    ├── test-data.json                 # Test data
    └── expected-output.json           # Expected output
```

## 🔍 Key Concepts

### 1. Multi-Sensor Data Parsing

```javascript
// Parse multiple parameters simultaneously
var temperature = view.getInt16(3, false) / 10.0;  // Temperature
var humidity = view.getUint16(5, false) / 10.0;    // Humidity
var battery = data[2];                              // Battery level
```

### 2. Bit Field Parsing

```javascript
// Extract multiple boolean values from one byte
var byte0 = data[0];
var humidityLowAlert = (byte0 >> 5) & 0x01;      // Bit 5
var humidityHighAlert = (byte0 >> 4) & 0x01;     // Bit 4
var temperatureLowAlert = (byte0 >> 3) & 0x01;   // Bit 3
var temperatureHighAlert = (byte0 >> 2) & 0x01;  // Bit 2
var buttonPressed = byte0 & 0x01;                // Bit 0
```

### 3. Multiple BACnet Object Types

```yaml
datatype:
  "1":
    type: AnalogInputObject    # Analog input - temperature sensor
  "4":
    type: BinaryInputObject    # Binary input - alarm status
```

### 4. Handling Different fPorts

```javascript
if (fPort == 10) {
  // Sensor data
}
if (fPort == 12) {
  // Configuration information
}
if (fPort == 13) {
  // Threshold settings
}
```

## 📊 Data Format Description

### fPort 10 - Sensor Data (7 bytes)

| Byte | Description | Data Type |
|------|-------------|-----------|
| 0 | Status flags | Bit field |
| 1 | Reserved | - |
| 2 | Battery level (%) | uint8 |
| 3-4 | Temperature (°C * 10) | int16 (big-endian) |
| 5-6 | Humidity (% * 10) | uint16 (big-endian) |

**Status Flags (Byte 0):**
```
Bit 7-6: Reserved
Bit 5: Humidity low alarm
Bit 4: Humidity high alarm
Bit 3: Temperature low alarm
Bit 2: Temperature high alarm
Bit 1: Reserved
Bit 0: Button pressed
```

### fPort 12 - Configuration Information (3 bytes)

| Byte | Description | Data Type |
|------|-------------|-----------|
| 0 | Command type (0x01) | uint8 |
| 1-2 | Report interval (seconds) | uint16 (big-endian) |

### fPort 13 - Threshold Configuration (6 bytes)

| Byte | Description | Data Type |
|------|-------------|-----------|
| 0 | Command type (0x02) | uint8 |
| 1-2 | High temperature threshold (°C) | int16 (big-endian) |
| 3-4 | Low temperature threshold (°C) | int16 (big-endian) |
| 5 | High humidity threshold (%) | uint8 |
| 6 | Low humidity threshold (%) | uint8 |

## 🧪 Test Data

Check the `tests/` directory for complete test cases, including:
- Normal data scenarios
- Alarm trigger scenarios
- Boundary value tests
- Configuration query responses

## 💡 Advanced Tips

### 1. COV Increment Settings

```yaml
covIncrement: 0.1    # Temperature change of 0.1°C triggers notification
covIncrement: 1.0    # Humidity change of 1% triggers notification
```

Adjust according to sensor precision and actual requirements.

### 2. Update Interval Settings

```yaml
updateInterval: 600   # Update every 10 minutes
```

Usually set to the device's actual reporting period.

### 3. Data Validation

Add data validation logic in Codec:
```javascript
// Temperature range check
if (temperature < -40 || temperature > 85) {
  // Abnormal data, may need to log or skip
}
```

## 📝 How to Create a Profile Based on This Example

### Step 1: Analyze Your Device Data Format
- Obtain data manual
- Record the meaning of each byte
- Confirm byte order (big-endian/little-endian)

### Step 2: Copy and Modify
```bash
cp examples/standard-profile/standard-temp-humidity-sensor.yaml profiles/YourVendor/YourVendor-Model.yaml
```

### Step 3: Modify Codec Functions
- Adjust parsing logic based on actual data format
- Add or remove sensor parameters
- Adjust data conversion factors

### Step 4: Configure BACnet Objects
- Select appropriate object type for each parameter
- Set correct units
- Configure COV and update intervals

### Step 5: Prepare Test Data
- Collect test data using real devices
- Create test cases for various scenarios
- Verify correctness of decode results

## ⚠️ Common Pitfalls

1. **Byte Order Error** - Confusing big-endian and little-endian
2. **Duplicate Channels** - Ensure each channel is unique
3. **Unit Mismatch** - Unit conversion in Codec must correspond to BACnet units
4. **Missing fPort** - Forgetting to handle certain fPort data
5. **Bit Operation Error** - Carefully verify bit shift and mask operations

## 🔽 Downlink Control

If your device supports downlink commands (e.g., setting a setpoint or toggling a relay), add an `Encode` function to the Codec and define Output-type BACnet objects in `datatype`.

### 1. Encode Function

The gateway calls `Encode(data, variables)` whenever the BMS writes to a writable BACnet object:

```javascript
function Encode(data, variables) {
    // data.channel : channel number of the BACnet Output object that was written
    // data.value   : value written to that object by the BMS
    var channel = data.channel;
    var value = data.value;
    var bytes = [];

    // Example: channel 11 = "Set Temperature Setpoint"
    if (channel === 11) {
        bytes.push(0x01);           // command type
        bytes.push(value & 0xFF);   // value low byte
    }
    // Add more channels as needed ...

    return bytes;
}

function encodeDownlink(input) {
    return { bytes: Encode(input.data, input.variables) };
}
```

### 2. Output Objects in datatype

Each controllable channel needs an Output/Value BACnet object with an `fport` field:

```yaml
datatype:
  # ... uplink objects (AnalogInputObject, BinaryInputObject, etc.) ...

  "11":
    name: Set Temperature Setpoint
    type: AnalogOutputObject    # writable by BMS
    units: degreesCelsius
    updateInterval: 60
    fport: 85                   # LoRaWAN fPort for the downlink frame
    channel: 11                 # passed as data.channel to Encode
```

### 3. End-to-End Downlink Flow

```
BMS writes value to BACnet object (AnalogOutputObject, channel 11)
    ↓
Gateway calls Encode({ channel: 11, value: 22.5 })
    ↓
Encode builds device-specific byte array
    ↓
Gateway sends downlink frame on fport: 85 (LoRaWAN)
    ↓
Device receives and applies the new setpoint
```

> **Reference:** See `profiles/Becasmart/Becasmart-BAC006.yaml` for a real-world example of a fully bidirectional Profile with multiple controllable channels.

## 🚀 Advanced Learning

After mastering this example, you can:
1. View actual Profile files in the repository
2. Study `profiles/Becasmart/Becasmart-BAC006.yaml` for a complete downlink implementation reference
3. Understand more complex data formats (e.g., TLV, Protocol Buffers)

---

**Tip**: It's recommended to study this example alongside real device data manuals for better results!
