import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  configureTestOrBenchmarkDatabase,
  isTestOrBenchmarkEnv,
} from './guard.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.resolve(__dirname, '../../.env');

if (isTestOrBenchmarkEnv()) {
  const isBench =
    process.env.SPORTZ_BENCHMARK === '1' ||
    process.env.SPORTZ_BENCHMARK === 'true' ||
    process.env.BENCHMARK_BYPASS_ARCJET === '1';

  configureTestOrBenchmarkDatabase({
    context: isBench ? 'benchmarks' : 'tests',
    markBenchmark: isBench,
  });

  // Load remaining non-DB env vars from .env without overriding DATABASE_URL
  dotenv.config({ path: envPath });
  dotenv.config();
} else {
  dotenv.config({ path: envPath });
  dotenv.config();
}
