/**
 * Renders the app icons electron-builder packages: icon.svg (the macOS grid, with its inset) to icon.png for the .icns,
 * and icon-full.svg (filling the canvas) to icon-full.png for Windows and Linux. Also copies icon-full.svg to the
 * website and docs, where it is the favicon and the header mark.
 */
import { copyFile } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';

const root = join(import.meta.dirname, '../..');
const render = (svg: string, png: string) => sharp(join(root, 'design', svg), { density: 300 }).resize(1024, 1024).png().toFile(join(root, 'apps/desktop/resources', png));
await render('icon.svg', 'icon.png');
await render('icon-full.svg', 'icon-full.png');
for (const to of ['apps/site/public/icon.svg', 'apps/docs/public/icon.svg', 'apps/docs/src/assets/icon.svg']) await copyFile(join(root, 'design/icon-full.svg'), join(root, to));
console.log('icons → apps/desktop/resources/icon.png, icon-full.png; icon-full.svg → site and docs');
