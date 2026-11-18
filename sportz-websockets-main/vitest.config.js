import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        pool: 'threads',
        fileParallelism: false,
        testTimeout: 20000,
        setupFiles: ['./test/setup.js'],
    },
});
