import { spawn } from 'child_process';

console.log('🚀 Starting Sportz Backend & Frontend concurrently...\n');

const backend = spawn('npm --prefix sportz-websockets-main run dev', {
  stdio: 'inherit',
  shell: true,
});

const frontend = spawn('npm --prefix sportz-frontend-main run dev', {
  stdio: 'inherit',
  shell: true,
});

const cleanup = () => {
  try {
    backend.kill();
  } catch {}
  try {
    frontend.kill();
  } catch {}
  process.exit();
};

process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);

backend.on('exit', (code) => {
  if (code !== 0 && code !== null) {
    console.error(`Backend process exited with code ${code}`);
  }
});

frontend.on('exit', (code) => {
  if (code !== 0 && code !== null) {
    console.error(`Frontend process exited with code ${code}`);
  }
});
