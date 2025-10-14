# RAK BACnet Profiles

[English](README.md) | [中文](README.zh-CN.md)

A repository of BACnet configuration profiles for LoRaWAN devices used with RAKwireless gateways. This repository contains mapping configuration files that convert LoRaWAN sensor/actuator data from multiple vendors to BACnet objects.

## 📋 Table of Contents

- [Introduction](#introduction)
- [Project Structure](#project-structure)
- [Profile Format](#profile-format)
- [Usage](#usage)
- [Contributing](#contributing)

## 📖 Introduction

This repository provides conversion configuration files from LoRaWAN devices to BACnet protocol. These profile files enable RAK gateways to map LoRaWAN device data to standard BACnet objects (such as Analog Input, Binary Input, Analog Output, etc.), achieving seamless integration with Building Management Systems (BMS).

### Key Features

- 🔄 Automatic LoRaWAN data encoding and decoding
- 📊 Mapping LoRaWAN data to standard BACnet objects
- 🏢 Support for various building sensors and actuators
- ⚙️ Configurable object properties (update interval, COV increment, etc.)
- 🔌 Support for bidirectional communication (read sensor data and control actuators)

## 📁 Project Structure

```
RAK-BACnet-Profiles/
├── Carrier/                    # Carrier brand device profiles
│   ├── Carrier-BAC-006-v4-20250709.yaml
│   └── 7201_V2_modify_0619.yaml
├── Dragino/                    # Dragino brand device profiles
│   ├── Dragino-LDS02.yaml     # Door sensor
│   └── Dragino-LES01.yaml     # Door/window sensor
├── Senso8/                     # Senso8 brand device profiles
│   ├── Senso8-LRS10701.yaml
│   ├── Senso8-LRS20100.yaml
│   ├── Senso8-LRS20200.yaml
│   ├── Senso8-LRS20310.yaml   # Water leak sensor
│   ├── Senso8-LRS20600.yaml
│   ├── Senso8-LRS20LD0.yaml
│   ├── Senso8-LRS20Uxx.yaml
│   ├── Senso8-LRS2M001.yaml
│   └── Senso8-LRS30100.yaml   # Multi-function environmental sensor
└── README.md
```

## 📝 Profile Format

Each YAML configuration file contains the following main sections:

### 1. Codec (Encoder/Decoder)

Defines JavaScript functions for encoding and decoding LoRaWAN data:

```yaml
codec: >
  function Decode(fPort, data, variables) {
    // Decode LoRaWAN uplink data
    var values = [];
    // ... parse data and populate values array
    return values;
  }

  function Encode(data, variables) {
    // Encode LoRaWAN downlink data
    var bytes = [];
    // ... encode data
    return bytes;
  }
```

### 2. Datatype (BACnet Object Definition)

Defines BACnet object types, properties, and mapping relationships:

```yaml
datatype:
  "1":                              # Channel ID
    name: Temperature               # Object name
    type: AnalogInputObject         # BACnet object type
    units: degreesCelsius          # Units
    covIncrement: 0.1              # COV increment
    updateInterval: 600            # Update interval (seconds)
    channel: 1                     # LoRaWAN channel number
```

**Supported BACnet Object Types:**
- `AnalogInputObject` - Analog input (sensor readings)
- `AnalogOutputObject` - Analog output (controllable analog values)
- `BinaryInputObject` - Binary input (switch states)
- `BinaryOutputObject` - Binary output (controllable switches)
- `OctetStringValueObject` - Octet string value object

### 3. LoRaWAN Configuration

Defines LoRaWAN related parameters:

```yaml
lorawan:
  adrAlgorithm: LoRa Only           # ADR algorithm
  classCDownlinkTimeout: 5          # Class C downlink timeout
  macVersion: LORAWAN_1_0_3         # LoRaWAN MAC version
  region: AS923                      # Regional frequency band
  regionalParametersRevision: A      # Regional parameters revision
  supportClassB: false              # Class B support
  supportClassC: false              # Class C support
  supportOTAA: true                 # OTAA support
```

### 4. Metadata

Device basic information:

```yaml
model: Senso8-LRS20310              # Device model
profileVersion: 1.0.0               # Profile version
name: LRS20310                      # Device name
vendor: RAKwireless                 # Vendor name
id: uuid-string                     # Unique identifier (optional)
```

## 🚀 Usage

### 1. Import Configuration File

Import the corresponding device YAML configuration file into the RAK gateway's BACnet service.

### 2. Device Join

Ensure the LoRaWAN device has successfully joined the RAK gateway (supports OTAA or ABP mode).

### 3. BACnet Object Mapping

The gateway will automatically create corresponding BACnet objects according to the configuration file and map LoRaWAN data to these objects.

### 4. BMS System Integration

In the Building Management System (BMS), access these objects through standard BACnet protocol to achieve device monitoring and control.

### Example: Reading Temperature Data

```
Device uplink data (LoRaWAN)
    ↓
Decode function parses
    ↓
Map to BACnet object (AnalogInputObject)
    ↓
BMS system reads (via BACnet protocol)
```

### Example: Controlling Air Conditioner

```
BMS system writes command (via BACnet protocol)
    ↓
BACnet object receives (AnalogOutputObject)
    ↓
Encode function encodes
    ↓
Downlink data sent (LoRaWAN)
```

## 🤝 Contributing

Contributions of new device configuration files are welcome!

### Adding New Device Profiles

1. **Fork this repository**

2. **Create device configuration file**
   - Create a new YAML file in the corresponding vendor directory
   - If it's a new vendor, create a new vendor directory
   - File naming format: `Vendor-Model.yaml`

3. **Write configuration file**
   - Implement Decode and Encode functions
   - Define BACnet object mappings
   - Configure LoRaWAN parameters
   - Add complete metadata information

4. **Testing and Validation**
   - Test the configuration file on actual devices
   - Verify data encoding/decoding correctness
   - Confirm BACnet object mapping works properly

5. **Submit Pull Request**
   - Provide detailed device description
   - Include test results and use cases
   - Update device list in this README

### Configuration File Specifications

- Use standard YAML format
- Clear code comments (JavaScript functions)
- Object naming follows BACnet specifications
- Units use standard BACnet unit enumerations
- Provide complete metadata information

## 📄 License

The configuration files in this project are for use with the RAKwireless ecosystem.

## 📧 Contact

For questions or suggestions, please contact us through:

- Submit a GitHub Issue
- Visit [RAKwireless Official Website](https://www.rakwireless.com/)
- Visit [RAKwireless Forum](https://forum.rakwireless.com/)

---

**Note:** Before using these configuration files, please ensure your RAK gateway firmware version supports BACnet functionality. Refer to the product documentation for specific support details.
