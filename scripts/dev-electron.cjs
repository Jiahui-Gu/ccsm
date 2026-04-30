#!/usr/bin/env node
const { spawn } = require('child_process');
const path = require('path');

const electronBin = require('electron');
const args = [];
if (process.env.CCSM_ELECTRON_INSPECT === '1') {
  args.push('--inspect=9229');
}
args.push(path.resolve(__dirname, '..'));

const child = spawn(electronBin, args, { stdio: 'inherit' });
child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});
