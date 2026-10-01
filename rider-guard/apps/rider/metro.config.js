const path = require('node:path');
const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);
// This repository uses separate installs rather than npm workspaces. Include the
// dependency-free engine that the rider app and presentation server share.
config.watchFolders = [...config.watchFolders, path.resolve(__dirname, '../../packages/demo'), path.resolve(__dirname, '../server/src/shared')];

module.exports = config;
