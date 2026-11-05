import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const projectDirectory = path.dirname(fileURLToPath(import.meta.url));
const downloadedAssetsDirectory = path.resolve(projectDirectory, 'runtime-assets');
const siteBase = '/SushySkin/';
const downloadedAssetsUrl = `${siteBase}@fs/${downloadedAssetsDirectory.replace(/\\/g, '/')}`;

const copyRuntimeAssets = {
  name: 'copy-runtime-assets',
  apply: 'build',
  closeBundle() {
    const outDir = path.resolve(projectDirectory, 'dist');
    fs.cpSync(downloadedAssetsDirectory, path.join(outDir, 'runtime-assets'), { recursive: true });
  },
};

export default defineConfig({
  base: siteBase,
  plugins: [copyRuntimeAssets],
  define: {
    __DOWNLOADED_ASSETS_BASE__: JSON.stringify(downloadedAssetsUrl),
  },
  server: {
    fs: { allow: [projectDirectory] },
  },
});
