import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEFAULT_RECORDINGS_DIR = path.resolve(__dirname, '../../recordings');

export class FeedRecorder {
    constructor(recordingsDir = DEFAULT_RECORDINGS_DIR) {
        this.recordingsDir = recordingsDir;
        this.activeFile = null;
    }

    async init(filename = null) {
        await fs.mkdir(this.recordingsDir, { recursive: true });
        const name = filename || `recording-${Date.now()}.jsonl`;
        this.activeFile = path.join(this.recordingsDir, name);
        console.log(`[Recorder] Initialized recording to: ${this.activeFile}`);
        return this.activeFile;
    }

    async record(rawPayload) {
        if (!this.activeFile) {
            await this.init();
        }

        const entry = {
            timestamp: Date.now(),
            payload: rawPayload,
        };

        const line = JSON.stringify(entry) + '\n';
        await fs.appendFile(this.activeFile, line, 'utf8');
        return entry;
    }

    static async readRecording(filePath) {
        const content = await fs.readFile(filePath, 'utf8');
        const lines = content.split('\n').filter((l) => l.trim().length > 0);
        return lines.map((line) => JSON.parse(line));
    }
}
