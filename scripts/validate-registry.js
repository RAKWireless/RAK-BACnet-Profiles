#!/usr/bin/env node

/**
 * Registry JSON Validator
 * 
 * Validates registry.json against registry-schema.json
 * 
 * Usage:
 *   node scripts/validate-registry.js
 */

const fs = require('fs');
const path = require('path');
const Ajv = require('ajv');
const addFormats = require('ajv-formats');

const { PINNED_VENDOR_FIRST } = require('./update-registry');

const REGISTRY_FILE = path.join(__dirname, '..', 'registry.json');
const SCHEMA_FILE = path.join(__dirname, '..', 'registry-schema.json');

/**
 * True when all PINNED_VENDOR_FIRST entries appear before any other vendor (matches update-registry.js order).
 */
function isPinnedVendorGroupedFirst(profiles) {
  let seenOtherVendor = false;
  for (const p of profiles) {
    if (p.vendor === PINNED_VENDOR_FIRST) {
      if (seenOtherVendor) return false;
    } else {
      seenOtherVendor = true;
    }
  }
  return true;
}

function validateRegistry() {
  console.log('🔍 Validating registry.json...\n');
  
  // Read files
  let registry, schema;
  
  try {
    registry = JSON.parse(fs.readFileSync(REGISTRY_FILE, 'utf8'));
    console.log('✅ Registry JSON parsed successfully');
  } catch (error) {
    console.error('❌ Failed to parse registry.json:', error.message);
    process.exit(1);
  }
  
  try {
    schema = JSON.parse(fs.readFileSync(SCHEMA_FILE, 'utf8'));
    console.log('✅ Schema JSON parsed successfully\n');
  } catch (error) {
    console.error('❌ Failed to parse registry-schema.json:', error.message);
    process.exit(1);
  }
  
  // Validate with AJV
  const ajv = new Ajv({ allErrors: true, verbose: true });
  addFormats(ajv);
  
  const validate = ajv.compile(schema);
  const valid = validate(registry);
  
  if (valid) {
    console.log('✅ Registry validation PASSED\n');
    
    // Print statistics
    console.log('📊 Registry Statistics:');
    console.log(`   Version: ${registry.version}`);
    console.log(`   Last Update: ${registry.lastUpdate}`);
    console.log(`   Total Profiles: ${registry.totalProfiles}`);
    console.log(`   With Tests: ${registry.statistics.withTests} | Without Tests: ${registry.statistics.withoutTests}\n`);
    
    // Check consistency
    console.log('🔍 Checking consistency...');
    
    const actualCount = registry.profiles.length;
    if (actualCount !== registry.totalProfiles) {
      console.warn(`⚠️  Warning: totalProfiles (${registry.totalProfiles}) doesn't match actual count (${actualCount})`);
    } else {
      console.log('✅ Profile count is consistent');
    }
    
    // Check vendor statistics
    const vendorCounts = {};
    for (const profile of registry.profiles) {
      vendorCounts[profile.vendor] = (vendorCounts[profile.vendor] || 0) + 1;
    }
    
    let vendorMismatch = false;
    for (const [vendor, count] of Object.entries(vendorCounts)) {
      if (registry.statistics.byVendor[vendor] !== count) {
        console.warn(`⚠️  Warning: Vendor ${vendor} count mismatch - registry: ${registry.statistics.byVendor[vendor]}, actual: ${count}`);
        vendorMismatch = true;
      }
    }
    
    if (!vendorMismatch) {
      console.log('✅ Vendor statistics are consistent');
    }

    if (registry.profiles.some(p => p.vendor === PINNED_VENDOR_FIRST)) {
      if (isPinnedVendorGroupedFirst(registry.profiles)) {
        console.log(`✅ ${PINNED_VENDOR_FIRST} profiles are listed first`);
      } else {
        console.warn(
          `⚠️  Warning: ${PINNED_VENDOR_FIRST} profiles should be listed first; run: node scripts/update-registry.js`
        );
      }
    }
    
    // Check test data statistics
    const withTestsCount = registry.profiles.filter(p => p.hasTests).length;
    if (withTestsCount !== registry.statistics.withTests) {
      console.warn(`⚠️  Warning: withTests count (${registry.statistics.withTests}) doesn't match actual (${withTestsCount})`);
    } else {
      console.log('✅ Test data statistics are consistent');
    }
    
    // Check file existence
    console.log('\n🔍 Checking file paths...');
    let missingFiles = 0;
    for (const profile of registry.profiles) {
      const filePath = path.join(__dirname, '..', profile.path);
      if (!fs.existsSync(filePath)) {
        console.error(`❌ File not found: ${profile.path}`);
        missingFiles++;
      }
    }
    
    if (missingFiles === 0) {
      console.log('✅ All profile files exist');
    } else {
      console.error(`\n❌ ${missingFiles} profile file(s) not found`);
    }
    
    console.log('\n✨ Validation complete!');
    
    if (missingFiles > 0) {
      process.exit(1);
    }
  } else {
    console.error('❌ Registry validation FAILED\n');
    console.error('Validation errors:');
    validate.errors.forEach((error, index) => {
      console.error(`\n${index + 1}. ${error.message}`);
      console.error(`   Path: ${error.instancePath || '(root)'}`);
      if (error.params) {
        console.error(`   Params:`, JSON.stringify(error.params, null, 2));
      }
    });
    process.exit(1);
  }
}

// Run validation
if (require.main === module) {
  validateRegistry();
}

module.exports = { validateRegistry };
