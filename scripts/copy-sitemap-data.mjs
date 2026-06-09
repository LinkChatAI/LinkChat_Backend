import { mkdirSync, copyFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const src = join(__dirname, '../src/data/sitemap-static-paths.json');
const destDir = join(__dirname, '../dist/data');
const dest = join(destDir, 'sitemap-static-paths.json');

mkdirSync(destDir, { recursive: true });
copyFileSync(src, dest);
console.log('Copied sitemap-static-paths.json to dist/data/');
