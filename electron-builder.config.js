const { rmSync, readdirSync, existsSync } = require('fs')
const { join } = require('path')

/**
 * After packing, prune files that are large and not needed at runtime:
 *  - llama/gitRelease.bundle  (~28MB git bundle used only for source builds)
 *  - llama/toolchains, cmake, xpack  (build tooling, not runtime)
 *  - node-llama-cpp bins for other platforms
 */
function afterPack({ appOutDir, electronPlatformName, arch }) {
  const resourcesDir = join(appOutDir, 'resources')
  const unpackedDir  = join(resourcesDir, 'app.asar.unpacked')
  const llamaDir     = join(unpackedDir, 'node_modules', 'node-llama-cpp', 'llama')
  const binsDir      = join(unpackedDir, 'node_modules', 'node-llama-cpp', 'bins')

  // ── Prune llama build artifacts ─────────────────────────────────────────────
  const llamaPrune = [
    'gitRelease.bundle',   // 28MB git bundle — not needed at runtime
    'toolchains',          // cmake toolchains
    'cmake',               // cmake modules
    'xpack',               // xpack tooling
  ]
  for (const name of llamaPrune) {
    const target = join(llamaDir, name)
    if (existsSync(target)) {
      rmSync(target, { recursive: true, force: true })
      console.log(`  pruned: llama/${name}`)
    }
  }

  // ── Prune bins for other platforms ──────────────────────────────────────────
  if (existsSync(binsDir)) {
    const platformPrefix =
      electronPlatformName === 'darwin'  ? `mac-${arch === 'arm64' ? 'arm64-metal' : 'x64'}` :
      electronPlatformName === 'win32'   ? 'win-x64' :
                                           'linux-x64'

    for (const entry of readdirSync(binsDir)) {
      if (entry.startsWith('_')) continue           // keep .moved.txt markers
      if (!entry.startsWith(platformPrefix)) {
        rmSync(join(binsDir, entry), { recursive: true, force: true })
        console.log(`  pruned bin: ${entry}`)
      }
    }
  }
}

/** @type {import('electron-builder').Configuration} */
module.exports = {
  appId: 'com.lumi.app',
  productName: 'Lumi',
  directories: {
    buildResources: 'build',
    output: 'dist',
  },

  files: [
    'out/**/*',
    '!out/**/*.map',
    // exclude large node-llama-cpp build artifacts from ASAR entirely
    '!node_modules/node-llama-cpp/llama/gitRelease.bundle',
    '!node_modules/node-llama-cpp/llama/toolchains/**',
    '!node_modules/node-llama-cpp/llama/cmake/**',
    '!node_modules/node-llama-cpp/llama/xpack/**',
    // exclude source maps, tests, docs from all node_modules
    '!node_modules/**/*.map',
    '!node_modules/**/test/**',
    '!node_modules/**/tests/**',
    '!node_modules/**/__tests__/**',
    '!node_modules/**/docs/**',
    '!node_modules/**/CHANGELOG*',
    '!node_modules/**/README*',
  ],

  asarUnpack: [
    'node_modules/node-llama-cpp/bins/**',
    'node_modules/node-llama-cpp/llama/addon/**',
    'node_modules/node-llama-cpp/llama/grammars/**',
    'node_modules/node-llama-cpp/llama/profiles/**',
    'node_modules/node-llama-cpp/llama/gpuInfo/**',
  ],

  afterPack,

  mac: {
    identity: null,
    gatekeeperAssess: false,
    hardenedRuntime: false,
    target: [{ target: 'dir' }],
    category: 'public.app-category.developer-tools',
  },

  win: {
    target: [{ target: 'nsis', arch: ['x64'] }],
  },

  nsis: {
    oneClick: false,
    allowToChangeInstallationDirectory: true,
  },

  linux: {
    target: ['AppImage'],
  },
}
