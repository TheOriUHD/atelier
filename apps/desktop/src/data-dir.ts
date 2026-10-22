/**
 * Where "Run on this computer" keeps its config (~/.atelier) and its data. The backend uses them; Settings ›
 * System shows the data folder.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { APP } from '@atelier/protocol';

export const localConfigDir = () => process.env.ATELIER_CONFIG_DIR ?? join(homedir(), APP.dirName);
export const localDataDir = () => process.env.ATELIER_DATA_DIR ?? join(localConfigDir(), 'data');
