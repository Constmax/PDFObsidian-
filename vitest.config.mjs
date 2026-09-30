import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';


export default defineConfig({
    resolve: {
        // The obsidian package has type definitions only.
        alias: { obsidian: fileURLToPath(new URL('./tests/obsidian-stub.ts', import.meta.url)) },
    },
    test: {
        include: ['tests/**/*.test.ts'],
    },
});
