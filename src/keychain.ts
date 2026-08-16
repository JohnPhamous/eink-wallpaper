import { spawn } from 'node:child_process';
import { KEYCHAIN_SERVICE } from './paths.js';

function security(args: string[], stdin?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('/usr/bin/security', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(Buffer.concat(stdout).toString('utf8').trim());
      else reject(new Error(Buffer.concat(stderr).toString('utf8').trim() || `security exited ${code}`));
    });
    if (stdin !== undefined) child.stdin.end(stdin);
    else child.stdin.end();
  });
}

function addSecret(account: string, secret: string): Promise<void> {
  return new Promise((resolve, reject) => {
    // `security ... -w` insists on reading from /dev/tty. Expect supplies a
    // private pseudo-terminal and reads the secret through stdin, keeping it out
    // of argv, environment variables, logs, and terminal echo.
    const expectScript = String.raw`
      log_user 0
      set timeout 15
      if {[gets stdin secret] < 0 || $secret eq ""} { exit 2 }
      set account ${JSON.stringify(account)}
      set service ${JSON.stringify(KEYCHAIN_SERVICE)}
      spawn /usr/bin/security add-generic-password -U -a $account -s $service -w
      expect {
        "password data for new item:" { send -- "$secret\r" }
        timeout { exit 3 }
        eof { exit 4 }
      }
      expect {
        "retype password for new item:" { send -- "$secret\r" }
        timeout { exit 5 }
        eof { exit 6 }
      }
      expect eof
      set result [wait]
      unset secret
      exit [lindex $result 3]
    `;
    const child = spawn('/usr/bin/expect', [
      '-c', expectScript,
    ], { stdio: ['pipe', 'ignore', 'ignore'] });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Unable to store Keychain secret: ${account}`));
    });
    child.stdin.end(`${secret}\n${secret}\n`);
  });
}

export async function setSecret(account: string, secret: string): Promise<void> {
  await addSecret(account, secret);
}

export async function getSecret(account: string): Promise<string> {
  try {
    return await security([
      'find-generic-password',
      '-a', account,
      '-s', KEYCHAIN_SERVICE,
      '-w',
    ]);
  } catch {
    throw new Error(`Missing Keychain secret: ${account}`);
  }
}

export async function hasSecret(account: string): Promise<boolean> {
  try {
    await getSecret(account);
    return true;
  } catch {
    return false;
  }
}
