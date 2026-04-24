#!/usr/bin/env node

/**
 * RAK BACnet Profile Registry Updater
 * 
 * This script automatically scans the profiles directory and generates/updates
 * the registry.json file with information about all available profiles.
 * 
 * Usage:
 *   node scripts/update-registry.js
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const PROFILES_DIR = path.join(__dirname, '..', 'profiles');
const REGISTRY_FILE = path.join(__dirname, '..', 'registry.json');
const REGISTRY_SCHEMA_FILE = './registry-schema.json';

/**
 * Get device type from profile data
 */
function guessDeviceType(vendor, model, profileData) {
  const modelLower = model.toLowerCase();
  const vendorLower = vendor.toLowerCase();
  
  // Common patterns
  if (modelLower.includes('temp') && modelLower.includes('humid')) return 'Temperature & Humidity Sensor';
  if (modelLower.includes('temp')) return 'Temperature Sensor';
  if (modelLower.includes('humid')) return 'Humidity Sensor';
  if (modelLower.includes('co2')) return 'CO2 Sensor';
  if (modelLower.includes('leak') || modelLower.includes('water')) return 'Water Leak Sensor';
  if (modelLower.includes('door') || modelLower.includes('window') || modelLower.includes('magnet')) return 'Door/Window Sensor';
  if (modelLower.includes('motion') || modelLower.includes('pir')) return 'PIR Motion Sensor';
  if (modelLower.includes('light')) return 'Light Sensor';
  if (modelLower.includes('button')) return 'Smart Button';
  if (modelLower.includes('ultrasonic') || modelLower.includes('distance')) return 'Ultrasonic Sensor';
  if (vendorLower === 'carrier' || modelLower.includes('hvac') || modelLower.includes('bac')) return 'HVAC Controller';
  
  // Check profile content
  if (profileData && profileData.datatype) {
    const datatypes = Object.values(profileData.datatype);
    const names = datatypes.map(dt => (dt.name || '').toLowerCase()).join(' ');
    
    if (names.includes('co2')) return 'CO2 Sensor';
    if (names.includes('tvoc') || names.includes('pm')) return 'Multi-sensor';
    if (names.includes('occupied')) return 'Occupancy Sensor';
  }
  
  return 'Sensor';
}

/**
 * Extract description from YAML comments or generate one
 */
function extractDescription(vendor, model, yamlContent, profileData) {
  // Try to extract from first few comment lines
  const lines = yamlContent.split('\n').slice(0, 10);
  for (const line of lines) {
    if (line.startsWith('# Device:')) {
      return line.replace('# Device:', '').trim();
    }
  }
  
  // Generate description
  const deviceType = guessDeviceType(vendor, model, profileData);
  return `${vendor} ${model} ${deviceType}`;
}

/**
 * Get models that have test data from vendor's test directory
 */
function getModelsWithTests(vendorDir) {
  const testsDir = path.join(vendorDir, 'tests');
  const modelsWithTests = new Set();
  
  if (fs.existsSync(testsDir)) {
    const testDataFile = path.join(testsDir, 'test-data.json');
    const expectedOutputFile = path.join(testsDir, 'expected-output.json');
    
    // Both files must exist
    if (fs.existsSync(testDataFile) && fs.existsSync(expectedOutputFile)) {
      try {
        const testData = JSON.parse(fs.readFileSync(testDataFile, 'utf8'));
        
        // Extract models from test cases
        if (testData.testCases && Array.isArray(testData.testCases)) {
          for (const testCase of testData.testCases) {
            if (testCase.model) {
              // Normalize model name (remove hyphens, convert to lowercase)
              const normalizedModel = testCase.model.toLowerCase().replace(/[-_]/g, '');
              modelsWithTests.add(normalizedModel);
            }
          }
        }
      } catch (error) {
        console.warn(`⚠️  Warning: Failed to parse test data for vendor directory: ${vendorDir}`);
      }
    }
  }
  
  return modelsWithTests;
}

/**
 * Get file modification date (used when profile content changed or is new)
 */
function getLastUpdateDate(filePath) {
  try {
    const stats = fs.statSync(filePath);
    return stats.mtime.toISOString().split('T')[0];
  } catch (error) {
    return new Date().toISOString().split('T')[0];
  }
}

/**
 * SHA-256 of profile file bytes (UTF-8) for stable change detection (mtime is not)
 */
function hashProfileContent(yamlContent) {
  return crypto.createHash('sha256').update(yamlContent, 'utf8').digest('hex');
}

/**
 * Preserve per-profile lastUpdate when YAML content unchanged vs existing registry.
 * First run after adding contentSha256: keep old lastUpdate (migration).
 */
function mergeLastUpdatesFromRegistry(existingRegistry, profiles) {
  const byPath = new Map();
  if (existingRegistry && Array.isArray(existingRegistry.profiles)) {
    for (const p of existingRegistry.profiles) {
      if (p && p.path) byPath.set(p.path, p);
    }
  }
  for (const profile of profiles) {
    const absPath = path.join(__dirname, '..', profile.path);
    const old = byPath.get(profile.path);
    if (old && old.contentSha256 === profile.contentSha256) {
      profile.lastUpdate = old.lastUpdate;
    } else if (old && old.contentSha256 === undefined) {
      profile.lastUpdate = old.lastUpdate;
    } else {
      profile.lastUpdate = getLastUpdateDate(absPath);
    }
  }
}

/**
 * Scan profiles directory and collect profile information
 */
function scanProfiles() {
  const profiles = [];
  
  // Read all vendor directories
  const vendors = fs.readdirSync(PROFILES_DIR, { withFileTypes: true })
    .filter(dirent => dirent.isDirectory())
    .map(dirent => dirent.name);
  
  for (const vendor of vendors) {
    const vendorDir = path.join(PROFILES_DIR, vendor);
    
    // Get models that have test data
    const modelsWithTests = getModelsWithTests(vendorDir);
    
    // Read all YAML files in vendor directory
    const yamlFiles = fs.readdirSync(vendorDir)
      .filter(file => file.endsWith('.yaml') || file.endsWith('.yml'));
    
    for (const yamlFile of yamlFiles) {
      const filePath = path.join(vendorDir, yamlFile);
      const yamlContent = fs.readFileSync(filePath, 'utf8');
      
      let profileData;
      try {
        profileData = yaml.load(yamlContent);
      } catch (error) {
        console.warn(`⚠️  Warning: Failed to parse ${vendor}/${yamlFile}: ${error.message}`);
        continue;
      }
      
      // Read model directly from profile YAML field
      const modelClean = profileData && profileData.model
        ? String(profileData.model)
        : yamlFile.replace(/^.*?-/, '').replace(/\.(yaml|yml)$/, '').replace(/_/g, ' ').replace(/-/g, ' ');

      // Generate ID from model field (lowercased, non-alphanumeric replaced with -)
      const id = modelClean.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

      // Normalize model name for comparison with test data
      const normalizedModel = modelClean.toLowerCase().replace(/[-_]/g, '');
      
      // Check if this specific model has test data
      const hasTests = modelsWithTests.has(normalizedModel);
      
      // Extract version from filename or default to 1.0.0
      const versionMatch = yamlFile.match(/v(\d+)/i);
      const version = versionMatch ? `${versionMatch[1]}.0.0` : '1.0.0';
      
      const deviceType = guessDeviceType(vendor, modelClean, profileData);
      const description = extractDescription(vendor, modelClean, yamlContent, profileData);
      const contentSha256 = hashProfileContent(yamlContent);
      const lastUpdate = getLastUpdateDate(filePath);
      
      profiles.push({
        id,
        vendor,
        model: modelClean,
        version,
        path: `profiles/${vendor}/${yamlFile}`,
        verified: hasTests,
        hasTests,
        description,
        deviceType,
        lorawanClass: ['A'], // Default, can be enhanced later
        contentSha256,
        lastUpdate
      });
    }
  }
  
  // Sort profiles by vendor and model
  profiles.sort((a, b) => {
    if (a.vendor !== b.vendor) return a.vendor.localeCompare(b.vendor);
    return a.model.localeCompare(b.model);
  });
  
  return profiles;
}

/**
 * Generate statistics from profiles
 */
function generateStatistics(profiles) {
  const byVendor = {};
  let withTests = 0;
  let withoutTests = 0;
  
  for (const profile of profiles) {
    // Count by vendor
    byVendor[profile.vendor] = (byVendor[profile.vendor] || 0) + 1;
    
    // Count test status
    if (profile.hasTests) {
      withTests++;
    } else {
      withoutTests++;
    }
  }
  
  return {
    byVendor,
    withTests,
    withoutTests
  };
}

/**
 * Load existing registry.json if present.
 */
function loadExistingRegistry() {
  try {
    const raw = fs.readFileSync(REGISTRY_FILE, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * True when registry payload matches except root lastUpdate.
 */
function isSameRegistryData(existing, generated) {
  if (!existing || !generated) return false;
  return (
    existing.version === generated.version &&
    existing.$schema === generated.$schema &&
    existing.totalProfiles === generated.totalProfiles &&
    JSON.stringify(existing.statistics) === JSON.stringify(generated.statistics) &&
    JSON.stringify(existing.profiles) === JSON.stringify(generated.profiles)
  );
}

function printRegistryStats(statistics, totalProfiles) {
  console.log('\n📊 Statistics:');
  console.log(`   Total Profiles: ${totalProfiles}`);
  console.log(`   With Tests: ${statistics.withTests} | Without Tests: ${statistics.withoutTests}`);
  console.log('\n📦 By Vendor:');
  for (const [vendor, count] of Object.entries(statistics.byVendor).sort()) {
    console.log(`   ${vendor}: ${count}`);
  }
  console.log('\n✨ Done!');
}

/**
 * Main function
 */
function main() {
  console.log('🔍 Scanning profiles directory...');
  
  const existingRegistry = loadExistingRegistry();
  const profiles = scanProfiles();
  mergeLastUpdatesFromRegistry(existingRegistry, profiles);
  console.log(`✅ Found ${profiles.length} profiles`);
  
  const statistics = generateStatistics(profiles);
  
  const today = new Date().toISOString().split('T')[0];
  const registry = {
    $schema: REGISTRY_SCHEMA_FILE,
    version: '1.0.0',
    lastUpdate: today,
    totalProfiles: profiles.length,
    profiles,
    statistics
  };
  
  if (existingRegistry && isSameRegistryData(existingRegistry, registry)) {
    registry.lastUpdate = existingRegistry.lastUpdate;
  }
  
  const output = JSON.stringify(registry, null, 2) + '\n';
  if (existingRegistry) {
    try {
      const previous = fs.readFileSync(REGISTRY_FILE, 'utf8');
      if (previous === output) {
        console.log(`📝 Registry unchanged (lastUpdate: ${registry.lastUpdate}), skipping write.`);
        printRegistryStats(statistics, profiles.length);
        return;
      }
    } catch {
      // fall through to write
    }
  }
  
  fs.writeFileSync(REGISTRY_FILE, output);
  console.log(`📝 Registry updated: ${REGISTRY_FILE}`);
  printRegistryStats(statistics, profiles.length);
}

// Run main function
if (require.main === module) {
  main();
}

module.exports = {
  scanProfiles,
  generateStatistics,
  hashProfileContent,
  mergeLastUpdatesFromRegistry,
  loadExistingRegistry,
  isSameRegistryData
};
