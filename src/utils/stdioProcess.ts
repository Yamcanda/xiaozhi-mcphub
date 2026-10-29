import { execFile } from 'node:child_process';
import treeKill from 'tree-kill';

const SNAPSHOT_TIMEOUT_MS = 5_000;
const STOP_TIMEOUT_MS = 10_000;
const POLL_INTERVAL_MS = 50;
const SNAPSHOT_MAX_BYTES = 4 * 1024 * 1024;
const WINDOWS_SNAPSHOT_COMMAND =
  "$ErrorActionPreference = 'Stop'; " +
  'Get-CimInstance -ClassName Win32_Process -Property ProcessId,ParentProcessId | ' +
  "ForEach-Object { '{0} {1}' -f $_.ProcessId, $_.ParentProcessId }";

function hasErrorCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (hasErrorCode(error, 'ESRCH')) return false;
    if (hasErrorCode(error, 'EPERM')) return true;
    throw error;
  }
}

async function snapshotProcessTree(pid: number): Promise<number[]> {
  const windows = process.platform === 'win32';
  const output = await new Promise<string>((resolve, reject) => {
    execFile(
      windows ? 'powershell.exe' : 'ps',
      windows
        ? ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', WINDOWS_SNAPSHOT_COMMAND]
        : ['-A', '-o', 'pid=', '-o', 'ppid='],
      {
        encoding: 'utf8',
        timeout: SNAPSHOT_TIMEOUT_MS,
        killSignal: 'SIGKILL',
        maxBuffer: SNAPSHOT_MAX_BYTES,
        windowsHide: true,
        shell: false,
      },
      (error, stdout) => {
        if (error) reject(error);
        else resolve(stdout);
      },
    );
  });

  if (!output.trim()) throw new Error('Cannot stop stdio process: process snapshot is empty');

  const childrenByParent = new Map<number, number[]>();
  const listedPids = new Set<number>();
  for (const line of output.trim().split(/\r?\n/)) {
    if (!line.trim()) continue;
    const match = /^(\d+)\s+(\d+)$/.exec(line.trim());
    if (!match) throw new Error('Cannot stop stdio process: invalid process snapshot');

    const childPid = Number(match[1]);
    const parentPid = Number(match[2]);
    if (
      !Number.isSafeInteger(childPid) ||
      !Number.isSafeInteger(parentPid) ||
      listedPids.has(childPid)
    ) {
      throw new Error('Cannot stop stdio process: invalid process snapshot');
    }
    listedPids.add(childPid);
    const children = childrenByParent.get(parentPid) ?? [];
    children.push(childPid);
    childrenByParent.set(parentPid, children);
  }

  if (!listedPids.has(pid) && isProcessAlive(pid)) {
    throw new Error('Cannot stop stdio process: live root PID is missing from the snapshot');
  }

  // Keep the captured IDs even if their parent exits or they are reparented later.
  const capturedPids = [pid];
  const captured = new Set(capturedPids);
  for (let index = 0; index < capturedPids.length; index++) {
    for (const childPid of childrenByParent.get(capturedPids[index]) ?? []) {
      if (captured.has(childPid)) continue;
      if (childPid <= 1 || childPid === process.pid) {
        throw new Error(
          'Refusing to stop a stdio process tree containing the current process or init',
        );
      }
      captured.add(childPid);
      capturedPids.push(childPid);
    }
  }
  return capturedPids;
}

function remainingTime(deadline: number): number {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error('Timed out stopping stdio process tree');
  return remaining;
}

async function forceKill(pid: number, deadline: number): Promise<void> {
  const timeoutMs = remainingTime(deadline);
  if (!isProcessAlive(pid)) return;

  if (process.platform === 'win32') {
    // tree-kill uses taskkill /T /F on Windows; also target captured orphans individually.
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error(`Timed out terminating stdio process ${pid}`)),
        timeoutMs,
      );
      const done = (error?: unknown): void => {
        clearTimeout(timeout);
        if (error && !hasErrorCode(error, 'ESRCH')) reject(error);
        else resolve();
      };
      try {
        treeKill(pid, 'SIGKILL', done);
      } catch (error) {
        done(error);
      }
    });
    return;
  }

  try {
    process.kill(pid, 'SIGKILL');
  } catch (error) {
    if (!hasErrorCode(error, 'ESRCH')) throw error;
  }
}

/**
 * Force-stop an owned stdio process tree. Await this BEFORE SDK client.close(),
 * which can otherwise orphan descendants before their IDs are captured.
 * Resolves only once every captured PID is absent; rejects on unsafe snapshots,
 * termination errors, or a 10-second overall deadline. Does not delete caches.
 */
export async function stopStdioProcessTree(pid: number): Promise<void> {
  if (!Number.isSafeInteger(pid) || pid <= 1 || pid === process.pid) {
    throw new Error(
      'Expected an owned stdio process PID greater than 1, other than the current PID',
    );
  }
  if (!['win32', 'linux', 'darwin'].includes(process.platform)) {
    throw new Error(`Unsupported platform for stopping stdio processes: ${process.platform}`);
  }

  const deadline = Date.now() + STOP_TIMEOUT_MS;
  const capturedPids = await snapshotProcessTree(pid);
  // Stop leaves first, without relying on a second enumeration after the parent dies.
  for (const capturedPid of [...capturedPids].reverse()) {
    await forceKill(capturedPid, deadline);
  }

  const pendingPids = new Set(capturedPids);
  while (pendingPids.size > 0) {
    for (const capturedPid of pendingPids) {
      if (!isProcessAlive(capturedPid)) pendingPids.delete(capturedPid);
    }
    if (pendingPids.size === 0) return;
    const delay = Math.min(POLL_INTERVAL_MS, remainingTime(deadline));
    await new Promise<void>((resolve) => setTimeout(resolve, delay));
  }
}
