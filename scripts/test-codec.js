#!/usr/bin/env node

/**
 * Codec Function Testing Tool
 * For testing encode/decode functions in Profiles
 */

const fs = require('fs');
const { hexToBytes, bytesToHex, formatHex } = require('./lib/hex-converter');
const { loadYAML, extractCodec } = require('./lib/yaml-parser');
const { invokeCodec } = require('./lib/codec-sandbox');

/**
 * Test Codec functions in sandbox
 * @param {string} codecSource - Codec JavaScript source code
 * @param {number} fPort - LoRaWAN fPort
 * @param {string} uplinkData - Uplink data in hexadecimal format
 * @returns {object} Decode result
 */
function testDecode(codecSource, fPort, uplinkData, options = {}) {
  const bytes = hexToBytes(uplinkData);
  const input = {
    bytes: bytes,
    fPort: parseInt(fPort),
    variables: {}
  };

  try {
    return invokeCodec(codecSource, 'decodeUplink', input, options.timeoutMs);
  } catch (error) {
    throw new Error(`Decode execution error: ${error.message}`);
  }
}

/**
 * Test encode function (downlink)
 * @param {string} codecSource - Codec JavaScript source code
 * @param {object} data - Data to encode
 * @returns {object} Encode result
 */
function testEncode(codecSource, data, options = {}) {
  try {
    return invokeCodec(codecSource, 'encodeDownlink', { data, variables: {} }, options.timeoutMs);
  } catch (error) {
    throw new Error(`Encode execution error: ${error.message}`);
  }
}

/**
 * Batch testing (from test data file)
 * @param {string} profilePath - Profile YAML file path
 * @param {string} testDataPath - Test data JSON file path
 * @returns {object} Test results
 */
function runBatchTest(profilePath, testDataPath) {
  const profile = loadYAML(profilePath);
  const codec = extractCodec(profile);
  
  const testData = JSON.parse(fs.readFileSync(testDataPath, 'utf8'));
  const results = {
    total: 0,
    passed: 0,
    failed: 0,
    tests: []
  };
  
  for (const testCase of testData.testCases || []) {
    results.total++;
    
    try {
      const result = testDecode(codec, testCase.fPort, testCase.input);
      const actual = result.data || [];
      const matched = !Object.prototype.hasOwnProperty.call(testCase, 'expectedOutput') ||
        JSON.stringify(actual) === JSON.stringify(testCase.expectedOutput);
      if (!matched) throw new Error('Output does not match expectedOutput');
      results.passed++;
      results.tests.push({ name: testCase.name, status: 'PASS', result, matched });
    } catch (error) {
      results.failed++;
      results.tests.push({
        name: testCase.name,
        status: 'FAIL',
        error: error.message
      });
    }
  }
  
  return results;
}

/**
 * Command line interface
 */
function main() {
  const args = process.argv.slice(2);
  
  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    console.log(`
Codec Function Testing Tool

Usage:
  node test-codec.js --file <profile.yaml> --port <fPort> --uplink <hex_data>
  node test-codec.js -f <profile.yaml> -p <fPort> -u <hex_data>
  node test-codec.js --batch <profile.yaml> <test-data.json>

Options:
  -f, --file <file>       Profile YAML file path
  -p, --port <port>       LoRaWAN fPort (default: 10)
  -u, --uplink <data>     Uplink data (hexadecimal format)
  -b, --batch             Batch test mode
  -h, --help              Show help information

Examples:
  # Single test
  node test-codec.js -f profiles/Senso8/Senso8-LRS20600.yaml -p 10 -u 040164010000000f41dc
  
  # Batch test
  node test-codec.js --batch profiles/Senso8/Senso8-LRS20600.yaml examples/minimal-profile/tests/test-data.json
    `);
    process.exit(0);
  }
  
  // Batch test mode
  if (args.includes('--batch') || args.includes('-b')) {
    const profilePath = args[1] || args[2];
    const testDataPath = args[2] || args[3];
    
    if (!profilePath || !testDataPath) {
      console.error('❌ Error: Batch test requires Profile path and test data path');
      process.exit(1);
    }
    
    try {
      console.log('🧪 Starting batch test...\n');
      const results = runBatchTest(profilePath, testDataPath);
      
      console.log(`📊 Test Results:`);
      console.log(`   Total: ${results.total}`);
      console.log(`   Passed: ${results.passed} ✅`);
      console.log(`   Failed: ${results.failed} ❌\n`);
      
      for (const test of results.tests) {
        if (test.status === 'PASS') {
          console.log(`✅ ${test.name}`);
          console.log(JSON.stringify(test.result, null, 2));
        } else {
          console.log(`❌ ${test.name}`);
          console.log(`   Error: ${test.error}`);
        }
        console.log('');
      }
      
      process.exit(results.failed > 0 ? 1 : 0);
      
    } catch (error) {
      console.error(`\n❌ Batch test failed: ${error.message}`);
      process.exit(1);
    }
    return;
  }
  
  // Single test mode
  let yamlFile = null;
  let fPort = '10';
  let uplinkData = null;
  
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '-f' || args[i] === '--file') {
      yamlFile = args[++i];
    } else if (args[i] === '-p' || args[i] === '--port') {
      fPort = args[++i];
    } else if (args[i] === '-u' || args[i] === '--uplink') {
      uplinkData = args[++i];
    }
  }
  
  if (!yamlFile) {
    console.error('❌ Error: Missing --file parameter');
    process.exit(1);
  }
  
  if (!uplinkData) {
    console.error('❌ Error: Missing --uplink parameter');
    process.exit(1);
  }
  
  try {
    console.log(`📖 Reading Profile: ${yamlFile}`);
    const profile = loadYAML(yamlFile);
    const codec = extractCodec(profile);
    
    console.log(`🧪 Testing decode: fPort=${fPort}, data=${formatHex(uplinkData)}`);
    const result = testDecode(codec, fPort, uplinkData);
    
    console.log('\n✅ Decode successful:');
    console.log(JSON.stringify(result, null, 2));
    
  } catch (error) {
    console.error('\n❌ Decode failed:');
    console.error(`   ${error.message}`);
    if (error.stack) {
      console.error('\nStack trace:');
      console.error(error.stack);
    }
    process.exit(1);
  }
}

// Run as main module
if (require.main === module) {
  main();
}

// Export functions for use by other modules
module.exports = {
  testDecode,
  testEncode,
  runBatchTest
};
