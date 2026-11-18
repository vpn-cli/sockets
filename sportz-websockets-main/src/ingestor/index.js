import 'dotenv/config';
import { runLiveIngest } from './live-runner.js';
import { runReplay } from './replay-runner.js';
import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function main() {
    const dataSource = (process.env.DATA_SOURCE || 'simulated').toLowerCase();
    console.log(`=======================================================`);
    console.log(`🚀 [Ingestor Service] DATA_SOURCE = ${dataSource.toUpperCase()}`);
    console.log(`=======================================================`);

    if (dataSource === 'live') {
        const apiKey = process.env.FOOTBALL_DATA_API_KEY;
        if (!apiKey) {
            console.error(`❌ [Ingestor Error] DATA_SOURCE=live requires FOOTBALL_DATA_API_KEY to be set in environment.`);
            process.exit(1);
        }
        await runLiveIngest({
            apiKey,
            pollIntervalSeconds: Number(process.env.POLL_INTERVAL_SECONDS || 60),
            record: process.env.RECORD === 'true' || process.env.RECORD === '1',
            apiUrl: process.env.API_URL || 'http://localhost:8000',
        });
    } else if (dataSource === 'replay') {
        const speed = process.env.REPLAY_SPEED || '1x';
        const recordingPath = process.env.RECORDING_PATH || null;
        const loop = process.env.REPLAY_LOOP !== 'false' && process.env.REPLAY_LOOP !== '0';
        await runReplay({
            recordingPath,
            speed,
            loop,
            apiUrl: process.env.API_URL || 'http://localhost:8000',
        });
    } else {
        // Default: simulated
        console.log(`[Ingestor] Running in SIMULATED mode. Delegating to seed worker...`);
        const seedScript = path.resolve(__dirname, '../seed/seed.js');
        const child = spawn(process.execPath, [seedScript], {
            env: {
                ...process.env,
                API_URL: process.env.API_URL || 'http://localhost:8000',
            },
            stdio: 'inherit',
        });

        child.on('exit', (code) => {
            console.log(`[Ingestor] Simulated seeder exited with code ${code}`);
            process.exit(code || 0);
        });
    }
}

main().catch((err) => {
    console.error(`❌ [Ingestor Fatal Error]`, err);
    process.exit(1);
});
