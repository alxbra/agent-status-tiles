import process from 'node:process';

import { validateBuiltHelper } from './build-hook-helper.mjs';

function helperArchitecture(arch) {
  if (arch === 3 || arch === 'arm64') {
    return 'arm64';
  }
  if (arch === 1 || arch === 'x64') {
    return 'x64';
  }
  throw new Error(`Unsupported Electron architecture for hook-helper: ${arch}`);
}

export default function validateHookHelperForPack(context) {
  if (context.electronPlatformName !== 'darwin' || process.platform !== 'darwin') {
    return;
  }
  validateBuiltHelper(helperArchitecture(context.arch));
}
