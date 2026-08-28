# Pull Request

## 📋 PR Type

Please select the type of this PR:

- [ ] 🆕 New Device Profile
- [ ] 🐛 Fix Existing Profile Bug
- [ ] 📝 Documentation Update
- [ ] 🔧 Other (please specify)

---

## 📦 Changes

### Summary
<!-- Briefly describe the main changes in this PR -->



### Device Information (if applicable for new/fixed profiles)

- **Vendor**: 
- **Model**: 
- **Profile File Path**: `profiles/`
- **Profile Version**: 

---

## ✅ Self-Check List

Please confirm that the following items have been completed:

### Basic Checks
- [ ] YAML file syntax is correct (no formatting errors)
- [ ] File naming follows convention (`Vendor-Model.yaml`)
- [ ] Profile version is set (`profileVersion`)
- [ ] All required fields are included (`vendor`, `model`, `codec`, `datatype`, `lorawan`)

### Codec Function Validation
- [ ] `Decode()` function implemented
- [ ] `decodeUplink()` function implemented
- [ ] `Encode()` and `encodeDownlink()` implemented when the Profile has writable objects
- [ ] Codec functions pass syntax checks (no JavaScript errors)
- [ ] Decoding functionality tested with real data

### BACnet Object Configuration
- [ ] BACnet object types are correct (only using supported 7 types)
- [ ] Channel numbers are unique and start from 1
- [ ] Units use BACnet standard unit names
- [ ] Reasonable `updateInterval` and `covIncrement` are set (if applicable)
- [ ] Every writable object declares an fPort from 1 through 254

### Device Testing
- [ ] Verified on real device (or provided sufficient test data)
- [ ] Test data covers main functional scenarios
- [ ] Decoding results match expectations
- [ ] Downlink bytes match known payloads or complete official documentation (if applicable)

### Documentation (if updated)
- [ ] Updated related README (if necessary)
- [ ] Added device description or special notes

---

## 🧪 Test Verification

### Test Data

Please provide at least 2 sets of test data for verification:

**Test Case 1:**
```
fPort: 
Uplink Data (Hex): 
```

**Expected Output:**
```json
{
  "data": [
    
  ]
}
```

---

**Test Case 2:**
```
fPort: 
Uplink Data (Hex): 
```

**Expected Output:**
```json
{
  "data": [
    
  ]
}
```

---

### Verification Method

Test codec functions using the Node.js validation script:

```bash
node scripts/test-codec.js \
  -f profiles/<Vendor>/<Model>.yaml \
  -p <fPort> \
  -u <hex_data>
```

**Verification Result**:
<!-- Paste command output -->
```

```

---

## 📚 Related Links

- **Related Issue**: #
- **Product Specification**: 
- **Device Manual**: 
- **Test Report**: 

---

## 💬 Additional Notes

### Special Configuration or Considerations
<!-- If the device has special configuration requirements, known issues, or usage notes, please specify here -->



### Other Information
<!-- Any other information reviewers need to know -->



---

## 📋 Reviewer Checklist

> **Note to Reviewer**: Please focus on the following aspects during review

- [ ] Profile structure completeness
- [ ] Codec function logic correctness
- [ ] BACnet object mapping reasonableness
- [ ] Test data sufficiency
- [ ] Code style and comments
- [ ] Documentation completeness

---

<!-- 
Thank you for your contribution! 🎉
Before submitting your PR, please ensure:
1. All self-check list items are checked
2. Sufficient test data is provided
3. Validation tool tests have passed
4. Related descriptions are filled in

We will review your PR as soon as possible. If there are any issues, we will provide feedback in the comments.
-->
