import { defineProject } from 'vitest/config';

export default defineProject({ test: { name: 'release', include: ['*.test.ts'] } });
