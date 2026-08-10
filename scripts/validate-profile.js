#!/usr/bin/env node

/**
 * Profile Validation Tool
 * Comprehensive validation for BACnet Profile configuration files
 */

const fs = require('fs');
const path = require('path');
const Ajv = require('ajv');
const {
  loadYAML,
  validateRequiredFields,
  validateBACnetObjects,
  extractVendorModel
} = require('./lib/yaml-parser');
const { testDecode } = require('./test-codec');
const { compileCodec } = require('./lib/codec-sandbox');

// Color output
const colors = {
  reset: '\x1b[0m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m'
};

/**
 * Validate YAML syntax
 * @param {string} filePath - YAML file path
 * @returns {object} Validation result
 */
function validateYAMLSyntax(filePath) {
  const errors = [];
  
  try {
    loadYAML(filePath);
  } catch (error) {
    errors.push(`YAML syntax error: ${error.message}`);
  }
  
  return {
    valid: errors.length === 0,
    errors
  };
}

/**
 * Validate Profile Schema
 * @param {object} profile - Profile object
 * @returns {object} Validation result
 */
function validateSchema(profile) {
  const ajv = new Ajv({ allErrors: true });
  const schemaPath = path.join(__dirname, 'schemas', 'profile-schema.json');
  const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
  
  const validate = ajv.compile(schema);
  const valid = validate(profile);
  
  const errors = validate.errors
    ? validate.errors.map(err => `${err.instancePath} ${err.message}`)
    : [];
  
  return {
    valid,
    errors
  };
}

/**
 * Validate Codec function syntax
 * @param {string} codecSource - Codec source code
 * @returns {object} Validation result
 */
function validateCodecSyntax(codecSource) {
  const errors = [];
  const warnings = [];
  
  // Check required functions
  const requiredFunctions = ['Decode', 'decodeUplink'];
  for (const func of requiredFunctions) {
    if (!codecSource.includes(func)) {
      errors.push(`Missing required function: ${func}`);
    }
  }
  
  // Check optional functions
  const optionalFunctions = ['Encode', 'encodeDownlink'];
  for (const func of optionalFunctions) {
    if (!codecSource.includes(func)) {
      warnings.push(`Optional function not found: ${func} (downlink control will be unavailable)`);
    }
  }
  
  // Compile in the restricted in-process runtime. The Profile Automation workflow
  // adds an outer no-network container boundary before executing generated code.
  try {
    compileCodec(codecSource);
  } catch (error) {
    errors.push(`JavaScript syntax error: ${error.message}`);
  }
  
  return {
    valid: errors.length === 0,
    errors,
    warnings
  };
}

/**
 * Validate file naming convention
 * @param {string} filePath - File path
 * @returns {object} Validation result
 */
function validateFileNaming(filePath) {
  const errors = [];
  const warnings = [];
  
  const filename = path.basename(filePath);
  
  // Check file extension
  if (!filename.endsWith('.yaml') && !filename.endsWith('.yml')) {
    errors.push('File must have .yaml or .yml extension');
  }
  
  // Check naming format (should be Vendor-Model.yaml)
  const namePattern = /^[A-Za-z0-9]+-[A-Za-z0-9-]+\.(yaml|yml)$/;
  if (!namePattern.test(filename)) {
    warnings.push('Filename should follow format: Vendor-Model.yaml');
  }
  
  // Check directory structure (should be under profiles/Vendor/)
  const parts = filePath.split(/[\/\\]/);
  if (parts.length >= 3) {
    const profilesIndex = parts.indexOf('profiles');
    if (profilesIndex >= 0 && profilesIndex < parts.length - 2) {
      const vendor = parts[profilesIndex + 1];
      if (!filename.startsWith(vendor)) {
        warnings.push(`Filename should start with vendor name: ${vendor}`);
      }
    }
  }
  
  return {
    valid: errors.length === 0,
    errors,
    warnings
  };
}

/**
 * Deep comparison of two values for equality
 * @param {*} actual - Actual value
 * @param {*} expected - Expected value
 * @returns {boolean} Whether they are equal
 */
function deepEqual(actual, expected) {
  // Handle null and undefined
  if (actual === expected) return true;
  if (actual == null || expected == null) return false;
  
  // Handle arrays
  if (Array.isArray(actual) && Array.isArray(expected)) {
    if (actual.length !== expected.length) return false;
    for (let i = 0; i < actual.length; i++) {
      if (!deepEqual(actual[i], expected[i])) return false;
    }
    return true;
  }
  
  // Handle objects
  if (typeof actual === 'object' && typeof expected === 'object') {
    const actualKeys = Object.keys(actual);
    const expectedKeys = Object.keys(expected);
    
    // Check key count
    if (actualKeys.length !== expectedKeys.length) return false;
    
    // Check each key and value
    for (const key of actualKeys) {
      if (!expectedKeys.includes(key)) return false;
      if (!deepEqual(actual[key], expected[key])) return false;
    }
    return true;
  }
  
  // Primitive type comparison
  return actual === expected;
}

/**
 * Extract model name from file path
 * @param {string} filePath - Profile YAML file path
 * @returns {string|null} Model name (e.g., "LRS20100")
 */
function extractModelFromPath(filePath) {
  const filename = path.basename(filePath, path.extname(filePath));
  // Match pattern: Vendor-Model (e.g., Senso8-LRS20100)
  const match = filename.match(/^[^-]+-(.+)$/);
  return match ? match[1] : null;
}

/**
 * Run test data validation
 * @param {object} profile - Profile object
 * @param {string} filePath - Profile file path
 * @returns {object} Validation result
 */
function runTestDataValidation(profile, filePath) {
  const errors = [];
  const warnings = [];
  const results = [];
  
  // Extract model from file path
  const currentModel = extractModelFromPath(filePath);
  
  // Find test data files
  const dir = path.dirname(filePath);
  const testDataPath = path.join(dir, 'tests', 'test-data.json');
  const expectedOutputPath = path.join(dir, 'tests', 'expected-output.json');
  
  if (!fs.existsSync(testDataPath)) {
    warnings.push('No test data found (tests/test-data.json)');
    return {
      valid: true,
      errors,
      warnings,
      results
    };
  }
  
  // Try to load expected output
  let expectedOutputData = null;
  if (fs.existsSync(expectedOutputPath)) {
    try {
      expectedOutputData = JSON.parse(fs.readFileSync(expectedOutputPath, 'utf8'));
    } catch (error) {
      warnings.push(`Failed to load expected output: ${error.message}`);
    }
  }
  
  try {
    const testData = JSON.parse(fs.readFileSync(testDataPath, 'utf8'));
    const codec = profile.codec;
    
    // Filter test cases by model
    const allTestCases = testData.testCases || [];
    const filteredTestCases = allTestCases.filter(tc => {
      // If test case has no model field, it applies to all models
      if (!tc.model) return true;
      // If we can't extract model from filename, run all tests
      if (!currentModel) return true;
      // Only run tests matching current model
      return tc.model === currentModel;
    });
    
    if (currentModel) {
      console.log(`  Model detected: ${currentModel}`);
      console.log(`  Running ${filteredTestCases.length} of ${allTestCases.length} test cases`);
    }
    
    for (let i = 0; i < filteredTestCases.length; i++) {
      const testCase = filteredTestCases[i];
      const originalIndex = allTestCases.indexOf(testCase);
      
      try {
        const result = testDecode(codec, testCase.fPort, testCase.input);
        
        // Find matching expected output by name and model
        let expectedOutput = null;
        if (expectedOutputData && expectedOutputData.testCases) {
          const expectedCase = expectedOutputData.testCases.find(ec => 
            ec.name === testCase.name && 
            (!ec.model || !testCase.model || ec.model === testCase.model)
          );
          if (expectedCase) {
            expectedOutput = expectedCase.expectedOutput;
          }
        }
        
        const actualOutput = result.data;
        
        if (expectedOutput) {
          // Compare actual output with expected output
          if (deepEqual(actualOutput, expectedOutput)) {
            results.push({
              name: testCase.name,
              model: testCase.model,
              status: 'PASS',
              result: result,
              matched: true
            });
          } else {
            // Output mismatch
            errors.push(`Test case '${testCase.name}' output mismatch`);
            results.push({
              name: testCase.name,
              model: testCase.model,
              status: 'FAIL',
              error: 'Output does not match expected result',
              actualOutput: actualOutput,
              expectedOutput: expectedOutput,
              matched: false
            });
          }
        } else {
          // No expected output, only check if execution succeeded
          results.push({
            name: testCase.name,
            model: testCase.model,
            status: 'PASS',
            result: result,
            matched: null
          });
        }
      } catch (error) {
        errors.push(`Test case '${testCase.name}' failed: ${error.message}`);
        results.push({
          name: testCase.name,
          model: testCase.model,
          status: 'FAIL',
          error: error.message
        });
      }
    }
  } catch (error) {
    errors.push(`Failed to load test data: ${error.message}`);
  }
  
  return {
    valid: errors.length === 0,
    errors,
    warnings,
    results,
    currentModel
  };
}

/**
 * Complete validation process
 * @param {string} filePath - Profile YAML file path
 * @param {object} options - Validation options
 * @returns {object} Complete validation result
 */
function validateProfile(filePath, options = {}) {
  const report = {
    file: filePath,
    timestamp: new Date().toISOString(),
    valid: true,
    checks: {}
  };
  
  console.log(`\n${'='.repeat(70)}`);
  console.log(`${colors.blue}Validating Profile: ${filePath}${colors.reset}`);
  console.log(`${'='.repeat(70)}\n`);
  
  // 1. YAML syntax validation
  console.log('📝 Checking YAML syntax...');
  const yamlCheck = validateYAMLSyntax(filePath);
  report.checks.yamlSyntax = yamlCheck;
  printResult(yamlCheck);
  
  if (!yamlCheck.valid) {
    report.valid = false;
    return report;
  }
  
  // Load Profile
  const profile = loadYAML(filePath);
  
  // 2. Schema validation
  console.log('\n📋 Checking Profile structure...');
  const schemaCheck = validateSchema(profile);
  report.checks.schema = schemaCheck;
  printResult(schemaCheck);
  if (!schemaCheck.valid) report.valid = false;
  
  // 3. Required fields validation
  console.log('\n📦 Checking required fields...');
  const fieldsCheck = validateRequiredFields(profile);
  report.checks.requiredFields = fieldsCheck;
  printResult(fieldsCheck);
  if (!fieldsCheck.valid) report.valid = false;
  
  // 4. Codec function validation
  console.log('\n🔧 Checking Codec functions...');
  const codecCheck = validateCodecSyntax(profile.codec);
  report.checks.codec = codecCheck;
  printResult(codecCheck);
  if (!codecCheck.valid) report.valid = false;
  
  // 5. BACnet object validation
  console.log('\n🏢 Checking BACnet object configuration...');
  const bacnetCheck = validateBACnetObjects(profile);
  report.checks.bacnet = bacnetCheck;
  printResult(bacnetCheck);
  if (!bacnetCheck.valid) report.valid = false;
  
  // 6. File naming validation
  console.log('\n📁 Checking file naming convention...');
  const namingCheck = validateFileNaming(filePath);
  report.checks.naming = namingCheck;
  printResult(namingCheck);
  
  // 7. Test data validation (complete validation)
  if (options.runTests !== false) {
    console.log('\n🧪 Running test data validation...');
    const testCheck = runTestDataValidation(profile, filePath);
    report.checks.tests = testCheck;
    printResult(testCheck);
    if (!testCheck.valid) report.valid = false;
    
    if (testCheck.results && testCheck.results.length > 0) {
      console.log('\nTest result details:');
      for (const test of testCheck.results) {
        const modelLabel = test.model ? ` [${test.model}]` : '';
        if (test.status === 'PASS') {
          if (test.matched === true) {
            console.log(`  ${colors.green}✓${colors.reset} ${test.name}${modelLabel} ${colors.green}[Output matched]${colors.reset}`);
          } else if (test.matched === null) {
            console.log(`  ${colors.green}✓${colors.reset} ${test.name}${modelLabel} ${colors.yellow}[Output not verified]${colors.reset}`);
          } else {
            console.log(`  ${colors.green}✓${colors.reset} ${test.name}${modelLabel}`);
          }
        } else {
          console.log(`  ${colors.red}✗${colors.reset} ${test.name}${modelLabel}: ${test.error}`);
          
          // Show detailed information if output mismatch
          if (test.matched === false && test.actualOutput && test.expectedOutput) {
            console.log(`    ${colors.yellow}Expected output:${colors.reset}`);
            console.log(`    ${JSON.stringify(test.expectedOutput, null, 2).split('\n').join('\n    ')}`);
            console.log(`    ${colors.yellow}Actual output:${colors.reset}`);
            console.log(`    ${JSON.stringify(test.actualOutput, null, 2).split('\n').join('\n    ')}`);
          }
        }
      }
    }
  }
  
  // Final result
  console.log(`\n${'='.repeat(70)}`);
  if (report.valid) {
    console.log(`${colors.green}✅ Validation passed${colors.reset}`);
  } else {
    console.log(`${colors.red}❌ Validation failed${colors.reset}`);
  }
  console.log(`${'='.repeat(70)}\n`);
  
  return report;
}

/**
 * Print validation result
 * @param {object} result - Validation result
 */
function printResult(result) {
  if (result.valid) {
    console.log(`  ${colors.green}✓ Pass${colors.reset}`);
  } else {
    console.log(`  ${colors.red}✗ Fail${colors.reset}`);
  }
  
  if (result.errors && result.errors.length > 0) {
    for (const error of result.errors) {
      console.log(`  ${colors.red}  ✗ ${error}${colors.reset}`);
    }
  }
  
  if (result.warnings && result.warnings.length > 0) {
    for (const warning of result.warnings) {
      console.log(`  ${colors.yellow}  ⚠ ${warning}${colors.reset}`);
    }
  }
}

/**
 * Command line interface
 */
function main() {
  const args = process.argv.slice(2);
  
  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    console.log(`
Profile Validation Tool

Usage:
  node validate-profile.js <profile.yaml> [options]

Options:
  --no-tests              Skip test data validation
  --json                  Output JSON format report
  -h, --help              Show help information

Examples:
  node validate-profile.js profiles/Senso8/Senso8-LRS20600.yaml
  node validate-profile.js profiles/Dragino/Dragino-LDS02.yaml --no-tests
  node validate-profile.js profiles/Milesight/Milesight-VS330.yaml --json
    `);
    process.exit(0);
  }
  
  const filePath = args[0];
  const options = {
    runTests: !args.includes('--no-tests'),
    jsonOutput: args.includes('--json')
  };
  
  if (!filePath) {
    console.error('❌ Error: Please provide Profile file path');
    process.exit(1);
  }
  
  if (!fs.existsSync(filePath)) {
    console.error(`❌ Error: File does not exist: ${filePath}`);
    process.exit(1);
  }
  
  try {
    const report = validateProfile(filePath, options);
    
    if (options.jsonOutput) {
      console.log(JSON.stringify(report, null, 2));
    }
    
    process.exit(report.valid ? 0 : 1);
  } catch (error) {
    console.error(`\n❌ Validation error: ${error.message}`);
    if (error.stack) {
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
  validateProfile,
  validateYAMLSyntax,
  validateSchema,
  validateCodecSyntax,
  validateBACnetObjects,
  validateFileNaming
};
