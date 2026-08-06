/**
 * YAML Parsing and Profile Extraction Tools
 */

const fs = require('fs');
const yaml = require('js-yaml');
const { ALLOWED_UNITS } = require('./units');

/**
 * Read and parse YAML file
 * @param {string} filePath - YAML file path
 * @returns {object} Parsed object
 */
function loadYAML(filePath) {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    return yaml.load(content);
  } catch (error) {
    throw new Error(`Failed to load YAML file ${filePath}: ${error.message}`);
  }
}

/**
 * Extract Codec function code from Profile
 * @param {object} profile - Profile object
 * @returns {string} Codec JavaScript code
 */
function extractCodec(profile) {
  if (!profile.codec) {
    throw new Error('No codec found in profile');
  }
  
  return profile.codec;
}

/**
 * Validate Profile required fields
 * @param {object} profile - Profile object
 * @returns {object} Validation result {valid: boolean, errors: string[]}
 */
function validateRequiredFields(profile) {
  const requiredFields = ['model', 'codec', 'datatype', 'lorawan'];
  const errors = [];
  
  for (const field of requiredFields) {
    if (!profile[field]) {
      errors.push(`Missing required field: ${field}`);
    }
  }
  
  // Validate codec field content
  if (profile.codec) {
    if (typeof profile.codec !== 'string') {
      errors.push('codec field must be a string');
    } else {
      // Check if required functions are included
      if (!profile.codec.includes('decodeUplink')) {
        errors.push('codec must include decodeUplink function');
      }
    }
  }
  
  // Validate datatype field
  if (profile.datatype) {
    if (typeof profile.datatype !== 'object') {
      errors.push('datatype field must be an object');
    } else {
      // Validate each channel configuration
      for (const [channel, config] of Object.entries(profile.datatype)) {
        if (!config || typeof config !== 'object' || Array.isArray(config)) {
          errors.push(`datatype.${channel}: configuration must be an object`);
          continue;
        }
        if (!config.name) {
          errors.push(`datatype.${channel}: missing 'name' field`);
        }
        if (!config.type) {
          errors.push(`datatype.${channel}: missing 'type' field`);
        }
      }
    }
  }
  
  // Validate lorawan field
  if (profile.lorawan) {
    const lorawanRequired = ['macVersion', 'supportClassB', 'supportClassC'];
    for (const field of lorawanRequired) {
      if (profile.lorawan[field] === undefined) {
        errors.push(`lorawan.${field} is required`);
      }
    }
  }
  
  return {
    valid: errors.length === 0,
    errors
  };
}

/**
 * Validate BACnet object types
 * @param {object} profile - Profile object
 * @returns {object} Validation result
 */
function validateBACnetObjects(profile) {
  const supportedTypes = [
    'AnalogInputObject',
    'AnalogOutputObject',
    'AnalogValueObject',
    'BinaryInputObject',
    'BinaryOutputObject',
    'BinaryValueObject',
    'OctetStringValueObject'
  ];
  
  const errors = [];
  const warnings = [];
  
  if (profile.datatype) {
    for (const [channel, config] of Object.entries(profile.datatype)) {
      if (!config || typeof config !== 'object' || Array.isArray(config)) {
        errors.push(`datatype.${channel}: configuration must be an object`);
        continue;
      }
      // Validate object type
      if (!supportedTypes.includes(config.type)) {
        errors.push(`datatype.${channel}: unsupported BACnet object type '${config.type}'`);
      }

      // Validate units against allowed BACnet unit list
      if (Object.prototype.hasOwnProperty.call(config, 'units') && config.units !== null) {
        if (typeof config.units !== 'string') {
          errors.push(`datatype.${channel}: units must be a string or null`);
        } else if (!ALLOWED_UNITS.has(config.units)) {
          errors.push(`datatype.${channel}: unsupported unit '${config.units}'`);
        }
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
 * 从 Profile 文件路径提取厂商和型号
 * @param {string} filePath - Profile 文件路径
 * @returns {object} {vendor: string, model: string}
 */
function extractVendorModel(filePath) {
  const parts = filePath.split(/[\/\\]/);
  const filename = parts[parts.length - 1];
  const vendor = parts[parts.length - 2] || 'Unknown';
  const model = filename.replace('.yaml', '').replace('.yml', '');
  
  return { vendor, model };
}

module.exports = {
  loadYAML,
  extractCodec,
  validateRequiredFields,
  validateBACnetObjects,
  extractVendorModel
};
