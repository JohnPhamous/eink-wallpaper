import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { atomicWrite, ensureDirectory } from './fs.js';
import { paths } from './paths.js';
import type { AppConfig } from './types.js';

const LABEL = 'com.phamous.eink-wallpaper';

function currentUid(): number {
  if (!process.getuid) throw new Error('LaunchAgent installation requires macOS or another POSIX system');
  return process.getuid();
}

function xml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function launchctl(args: string[], allowFailure = false): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('/bin/launchctl', args, { stdio: 'pipe' });
    const stderr: Buffer[] = [];
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0 || allowFailure) resolve();
      else reject(new Error(Buffer.concat(stderr).toString('utf8').trim() || `launchctl exited ${code}`));
    });
  });
}

function executableEntry(): string {
  const entry = fileURLToPath(new URL('./cli.js', import.meta.url));
  if (!entry.includes(`${path.sep}dist${path.sep}`)) {
    throw new Error('Build the CLI before installing: npm run build');
  }
  return entry;
}

function calendarReaderEntry(): string {
  return fileURLToPath(new URL('../bin/Eink Calendar Reader.app/Contents/MacOS/eink-calendar-reader', import.meta.url));
}

function calendarIntervals(config: AppConfig): string {
  return [0, 2, 4].map((offset) => `
  <dict>
    <key>Hour</key><integer>${(config.schedule.hour + offset) % 24}</integer>
    <key>Minute</key><integer>${config.schedule.minute}</integer>
  </dict>`).join('');
}

export async function installLaunchAgent(config: AppConfig): Promise<void> {
  await ensureDirectory(path.dirname(paths.launchAgent));
  await ensureDirectory(paths.logs);
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(calendarReaderEntry())}</string>
    <string>run-pipeline</string>
    <string>${xml(process.execPath)}</string>
    <string>${xml(executableEntry())}</string>
    <string>run</string>
    <string>--scheduled</string>
  </array>
  <key>StartCalendarInterval</key>
  <array>${calendarIntervals(config)}
  </array>
  <key>ProcessType</key><string>Background</string>
  <key>LowPriorityIO</key><true/>
  <key>StandardOutPath</key><string>${xml(path.join(paths.logs, 'launchd.out.log'))}</string>
  <key>StandardErrorPath</key><string>${xml(path.join(paths.logs, 'launchd.err.log'))}</string>
</dict>
</plist>
`;
  await atomicWrite(paths.launchAgent, plist, 0o644);
  const domain = `gui/${currentUid()}`;
  await launchctl(['bootout', domain, paths.launchAgent], true);
  await launchctl(['bootstrap', domain, paths.launchAgent]);
}

export async function uninstallLaunchAgent(): Promise<void> {
  await launchctl(['bootout', `gui/${currentUid()}`, paths.launchAgent], true);
}

export async function kickstartLaunchAgent(): Promise<void> {
  await launchctl(['kickstart', `gui/${currentUid()}/${LABEL}`]);
}
