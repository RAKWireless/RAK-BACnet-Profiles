#!/usr/bin/env node

/**
 * Generate Expected Output Tool
 * 
 * Uses profile's codec to decode test data and generate expected outputs.
 * This allows automated testing - if the codec changes, expected outputs must be regenerated.
 * 
 * Usage:
 *   node generate-expected-output.js <profile-path> <test-data-path>
 * 
 * Example:
 *   node generate-expected-output.js profiles/Senso8/Senso8-LRS20100.yaml profiles/Senso8/tests/test-data.json
 */

const fs = require('fs');
const path = require('path');
const { loadYAML, extractCodec } = require('./lib/yaml-parser');
const { testDecode } = require('./test-codec');

/**
 * Generate expected output for a single test case
 * @param {string} codecSource - Codec JavaScript source code
 * @param {object} testCase - Test case with fPort and input
 * @returns {object} Expected output with decoded values
 */
function generateExpectedForTestCase(codecSource, testCase) {
  try {
    const result = testDecode(codecSource, testCase.fPort, testCase.input);
    return {
      name: testCase.name,
      model: testCase.model,
      fPort: testCase.fPort,
      input: testCase.input,
      output: result.data || result,
      success: true
    };
  } catch (error) {
    return {
      name: testCase.name,
      model: testCase.model,
      fPort: testCase.fPort,
      input: testCase.input,
      error: error.message,
      success: false
    };
  }
}

/**
 * Main function
 */
function main() {
  const args = process.argv.slice(2);
  
  if (args.length < 2) {
    console.error('Usage: node generate-expected-output.js <profile-path> <test-data-path>');
    console.error('');
    console.error('Example:');
    console.error('  node generate-expected-output.js profiles/Senso8/Senso8-LRS20100.yaml profiles/Senso8/tests/test-data.json');
    process.exit(1);
  }
  
  const profilePath = args[0];
  const testDataPath = args[1];
  
  // Check files exist
  if (!fs.existsSync(profilePath)) {
    console.error(`Error: Profile file not found: ${profilePath}`);
    process.exit(1);
  }
  
  if (!fs.existsSync(testDataPath)) {
    console.error(`Error: Test data file not found: ${testDataPath}`);
    process.exit(1);
  }
  
  // Load profile and extract codec
  let profile;
  let codecSource;
  try {
    profile = loadYAML(profilePath);
    codecSource = extractCodec(profile);
  } catch (error) {
    console.error(`Error loading profile: ${error.message}`);
    process.exit(1);
  }
  
  // Load test data
  let testData;
  try {
    testData = JSON.parse(fs.readFileSync(testDataPath, 'utf8'));
  } catch (error) {
    console.error(`Error loading test data: ${error.message}`);
    process.exit(1);
  }
  
  // Generate expected outputs for all test cases
  const expectedOutputs = {
    device: testData.device,
    generatedAt: new Date().toISOString(),
    profile: path.basename(profilePath),
    results: testData.testCases.map(testCase => 
      generateExpectedForTestCase(codecSource, testCase)
    )
  };
  
  // Count successes and failures
  const successCount = expectedOutputs.results.filter(r => r.success).length;
  const failureCount = expectedOutputs.results.length - successCount;
  
  // Output to stdout (Python script will capture this)
  console.log(JSON.stringify(expectedOutputs, null, 2));
  
  // Log summary to stderr
  console.error(`Generated expected output for ${testData.device}:`);
  console.error(`  Total test cases: ${expectedOutputs.results.length}`);
  console.error(`  Success: ${successCount}`);
  console.error(`  Failed: ${failureCount}`);
  
  if (failureCount > 0) {
    process.exit(1);
  }
  
  process.exit(0);
}

if (require.main === module) {
  main();
}

module.exports = { generateExpectedForTestCase };
