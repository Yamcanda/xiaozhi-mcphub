import {
  execFile,
  type ChildProcess,
  type ExecFileOptionsWithStringEncoding,
} from 'node:child_process';
import treeKill from 'tree-kill';
import { stopStdioProcessTree } from '../../src/utils/stdioProcess.js';

jest.mock('node:child_process', () => ({ execFile: jest.fn() }));
jest.mock('tree-kill', () => ({ __esModule: true, default: jest.fn() }));

type SnapshotCallback = (error: Error | null, stdout: string, stderr: string) => void;
type SnapshotExec = (
  file: string,
  args: readonly string[],
  options: ExecFileOptionsWithStringEncoding,
  callback: SnapshotCallback,
) => ChildProcess;

const execFileMock = execFile as unknown as jest.MockedFunction<SnapshotExec>;
const treeKillMock = jest.mocked(treeKill);
const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
const ROOT_PID = 2_000_000_000;
const CHILD_PID = ROOT_PID + 1;
const GRANDCHILD_PID = ROOT_PID + 2;
const UNRELATED_PID = ROOT_PID + 3;
const SNAPSHOT = [
  '1 0',
  '20 1',
  `${ROOT_PID} 20`,
  `${CHILD_PID} ${ROOT_PID}`,
  `${GRANDCHILD_PID} ${CHILD_PID}`,
  `${UNRELATED_PID} 20`,
  `${UNRELATED_PID + 1} ${UNRELATED_PID}`,
].join('\n');

function processError(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(code), { code });
}

function setPlatform(platform: string): void {
  Object.defineProperty(process, 'platform', { configurable: true, value: platform });
}

describe('stopStdioProcessTree', () => {
  let alivePids: Set<number>;
  let killMock: jest.SpiedFunction<typeof process.kill>;

  beforeEach(() => {
    jest.useFakeTimers({ now: 0 });
    setPlatform('linux');
    alivePids = new Set([ROOT_PID, CHILD_PID, GRANDCHILD_PID, UNRELATED_PID]);
    // No test can execute a command or signal a real process.
    execFileMock.mockReset().mockImplementation((_file, _args, _options, callback) => {
      callback(null, SNAPSHOT, '');
      return {} as ChildProcess;
    });
    treeKillMock.mockReset().mockImplementation((pid, _signal, callback) => {
      alivePids.delete(pid);
      callback?.();
    });
    killMock = jest.spyOn(process, 'kill').mockImplementation((pid, signal) => {
      if (!alivePids.has(pid)) throw processError('ESRCH');
      if (signal === 'SIGKILL') alivePids.delete(pid);
      else if (signal !== 0) throw new Error('Unexpected signal in mocked process.kill');
      return true;
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
    if (originalPlatform) Object.defineProperty(process, 'platform', originalPlatform);
  });

  it.each(['linux', 'darwin'])(
    'captures and force-kills only the numeric owned tree on %s',
    async (platform) => {
      setPlatform(platform);

      await stopStdioProcessTree(ROOT_PID);

      expect(execFileMock).toHaveBeenCalledTimes(1);
      expect(execFileMock).toHaveBeenCalledWith(
        'ps',
        ['-A', '-o', 'pid=', '-o', 'ppid='],
        expect.objectContaining({
          encoding: 'utf8',
          timeout: 5_000,
          killSignal: 'SIGKILL',
          maxBuffer: 4 * 1024 * 1024,
          shell: false,
        }),
        expect.any(Function),
      );
      expect(killMock.mock.calls.filter(([, signal]) => signal === 'SIGKILL')).toEqual([
        [GRANDCHILD_PID, 'SIGKILL'],
        [CHILD_PID, 'SIGKILL'],
        [ROOT_PID, 'SIGKILL'],
      ]);
      expect(alivePids).toEqual(new Set([UNRELATED_PID]));
      expect(treeKillMock).not.toHaveBeenCalled();
    },
  );

  it('finishes its snapshot before termination and before a caller closes the SDK client', async () => {
    let snapshotCallback: SnapshotCallback | undefined;
    execFileMock.mockImplementation((_file, _args, _options, callback) => {
      snapshotCallback = callback;
      return {} as ChildProcess;
    });
    const closeClient = jest.fn();
    const operation = stopStdioProcessTree(ROOT_PID).then(closeClient);

    expect(execFileMock).toHaveBeenCalledTimes(1);
    expect(killMock).not.toHaveBeenCalled();
    expect(treeKillMock).not.toHaveBeenCalled();
    expect(closeClient).not.toHaveBeenCalled();

    snapshotCallback?.(null, SNAPSHOT, '');
    await operation;

    expect(closeClient).toHaveBeenCalledTimes(1);
    expect(killMock.mock.invocationCallOrder.at(-1)).toBeLessThan(
      closeClient.mock.invocationCallOrder[0],
    );
  });

  it('snapshots Windows parent IDs with noninteractive CIM and uses tree-kill taskkill /T /F', async () => {
    setPlatform('win32');
    execFileMock.mockImplementation((_file, _args, _options, callback) => {
      callback(null, `0 0\r\n${SNAPSHOT.replace(/\n/g, '\r\n')}\r\n`, '');
      return {} as ChildProcess;
    });

    await stopStdioProcessTree(ROOT_PID);

    expect(execFileMock).toHaveBeenCalledTimes(1);
    expect(execFileMock).toHaveBeenCalledWith(
      'powershell.exe',
      [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        "$ErrorActionPreference = 'Stop'; " +
          'Get-CimInstance -ClassName Win32_Process -Property ProcessId,ParentProcessId | ' +
          "ForEach-Object { '{0} {1}' -f $_.ProcessId, $_.ParentProcessId }",
      ],
      expect.objectContaining({ timeout: 5_000, shell: false, windowsHide: true }),
      expect.any(Function),
    );
    expect(treeKillMock.mock.calls.map(([pid, signal]) => [pid, signal])).toEqual([
      [GRANDCHILD_PID, 'SIGKILL'],
      [CHILD_PID, 'SIGKILL'],
      [ROOT_PID, 'SIGKILL'],
    ]);
    expect(killMock.mock.calls.every(([, signal]) => signal === 0)).toBe(true);
    expect(alivePids).toEqual(new Set([UNRELATED_PID]));
  });

  it.each(['linux', 'win32'])(
    'waits for captured descendants even after their parent exits on %s',
    async (platform) => {
      setPlatform(platform);
      killMock.mockImplementation((pid, signal) => {
        if (!alivePids.has(pid)) throw processError('ESRCH');
        if (signal === 'SIGKILL' && pid === ROOT_PID) alivePids.delete(pid);
        return true;
      });
      treeKillMock.mockImplementation((pid, _signal, callback) => {
        if (pid === ROOT_PID) alivePids.delete(pid);
        callback?.();
      });
      const completed = jest.fn();
      const operation = stopStdioProcessTree(ROOT_PID).then(completed);
      await jest.advanceTimersByTimeAsync(0);

      expect(alivePids.has(ROOT_PID)).toBe(false);
      expect(completed).not.toHaveBeenCalled();
      alivePids.delete(GRANDCHILD_PID);
      await jest.advanceTimersByTimeAsync(100);
      expect(completed).not.toHaveBeenCalled();
      expect(killMock).toHaveBeenCalledWith(CHILD_PID, 0);
      alivePids.delete(CHILD_PID);
      await jest.advanceTimersByTimeAsync(50);
      await operation;

      expect(completed).toHaveBeenCalledTimes(1);
      expect(execFileMock).toHaveBeenCalledTimes(1);
      expect(alivePids.has(UNRELATED_PID)).toBe(true);
    },
  );

  it('still terminates captured children when the root is already missing', async () => {
    alivePids.delete(ROOT_PID);
    execFileMock.mockImplementation((_file, _args, _options, callback) => {
      callback(null, SNAPSHOT.replace(`${ROOT_PID} 20\n`, ''), '');
      return {} as ChildProcess;
    });

    await stopStdioProcessTree(ROOT_PID);

    expect(killMock).toHaveBeenCalledWith(CHILD_PID, 'SIGKILL');
    expect(killMock).toHaveBeenCalledWith(GRANDCHILD_PID, 'SIGKILL');
    expect(killMock).not.toHaveBeenCalledWith(ROOT_PID, 'SIGKILL');
  });

  it('succeeds when the root and its descendants are absent', async () => {
    alivePids.clear();
    execFileMock.mockImplementation((_file, _args, _options, callback) => {
      callback(null, '1 0\n20 1\n', '');
      return {} as ChildProcess;
    });

    await expect(stopStdioProcessTree(ROOT_PID)).resolves.toBeUndefined();

    expect(killMock.mock.calls.every(([, signal]) => signal === 0)).toBe(true);
    expect(treeKillMock).not.toHaveBeenCalled();
  });

  it.each(['linux', 'win32'])(
    'treats ESRCH during termination as success on %s',
    async (platform) => {
      setPlatform(platform);
      killMock.mockImplementation((pid, signal) => {
        if (!alivePids.has(pid)) throw processError('ESRCH');
        if (signal === 'SIGKILL') {
          alivePids.delete(pid);
          throw processError('ESRCH');
        }
        return true;
      });
      treeKillMock.mockImplementation((pid, _signal, callback) => {
        alivePids.delete(pid);
        callback?.(processError('ESRCH'));
      });

      await expect(stopStdioProcessTree(ROOT_PID)).resolves.toBeUndefined();
    },
  );

  it.each(['linux', 'win32'])('rejects termination permission errors on %s', async (platform) => {
    setPlatform(platform);
    const error = processError('EPERM');
    killMock.mockImplementation((_pid, signal) => {
      if (signal === 'SIGKILL') throw error;
      return true;
    });
    treeKillMock.mockImplementation((_pid, _signal, callback) => callback?.(error));

    await expect(stopStdioProcessTree(ROOT_PID)).rejects.toBe(error);
  });

  it('rejects synchronous tree-kill failures', async () => {
    setPlatform('win32');
    const error = processError('EACCES');
    treeKillMock.mockImplementation(() => {
      throw error;
    });

    await expect(stopStdioProcessTree(ROOT_PID)).rejects.toBe(error);
  });

  it('treats EPERM probes as alive and rejects if a captured process never disappears', async () => {
    killMock.mockImplementation((_pid, signal) => {
      if (signal === 0) throw processError('EPERM');
      return true;
    });
    const assertion = expect(stopStdioProcessTree(ROOT_PID)).rejects.toThrow('Timed out');

    await jest.advanceTimersByTimeAsync(10_000);
    await assertion;

    expect(Date.now()).toBe(10_000);
    expect(killMock).toHaveBeenCalledWith(GRANDCHILD_PID, 0);
  });

  it('bounds a hung Windows tree-kill callback by the overall deadline', async () => {
    setPlatform('win32');
    treeKillMock.mockImplementation(() => undefined);
    const assertion = expect(stopStdioProcessTree(ROOT_PID)).rejects.toThrow(
      'Timed out terminating',
    );

    await jest.advanceTimersByTimeAsync(10_000);
    await assertion;

    expect(treeKillMock).toHaveBeenCalledTimes(1);
  });

  it('does not restart the deadline for each Windows termination', async () => {
    setPlatform('win32');
    treeKillMock
      .mockImplementationOnce((pid, _signal, callback) => {
        setTimeout(() => {
          alivePids.delete(pid);
          callback?.();
        }, 6_000);
      })
      .mockImplementation(() => undefined);
    const assertion = expect(stopStdioProcessTree(ROOT_PID)).rejects.toThrow(
      'Timed out terminating',
    );

    await jest.advanceTimersByTimeAsync(10_000);
    await assertion;

    expect(treeKillMock).toHaveBeenCalledTimes(2);
    expect(Date.now()).toBe(10_000);
  });

  it('rejects unexpected process-probe errors instead of reporting exit', async () => {
    const error = processError('EACCES');
    killMock.mockImplementation(() => {
      throw error;
    });

    await expect(stopStdioProcessTree(ROOT_PID)).rejects.toBe(error);

    expect(treeKillMock).not.toHaveBeenCalled();
  });

  it.each(['EPERM', 'ENOENT', 'ETIMEDOUT'])(
    'fails closed on snapshot command errors (%s)',
    async (code) => {
      const error = processError(code);
      execFileMock.mockImplementation((_file, _args, _options, callback) => {
        callback(error, SNAPSHOT, 'listing failed');
        return {} as ChildProcess;
      });

      await expect(stopStdioProcessTree(ROOT_PID)).rejects.toBe(error);

      expect(killMock).not.toHaveBeenCalled();
      expect(treeKillMock).not.toHaveBeenCalled();
    },
  );

  it.each([
    '',
    'not a process list',
    `${ROOT_PID} missing-parent`,
    `${ROOT_PID} 20\n${ROOT_PID} 20`,
    '9007199254740992 20',
    '1 0\n20 1',
  ])('fails closed on an empty, invalid, or incomplete snapshot: %j', async (snapshot) => {
    execFileMock.mockImplementation((_file, _args, _options, callback) => {
      callback(null, snapshot, '');
      return {} as ChildProcess;
    });

    await expect(stopStdioProcessTree(ROOT_PID)).rejects.toThrow(/snapshot/);

    expect(killMock.mock.calls.every(([, signal]) => signal === 0)).toBe(true);
    expect(treeKillMock).not.toHaveBeenCalled();
  });

  it.each([1, process.pid])(
    'refuses snapshots containing protected descendant %s',
    async (protectedPid) => {
      execFileMock.mockImplementation((_file, _args, _options, callback) => {
        callback(null, `${ROOT_PID} 20\n${protectedPid} ${ROOT_PID}`, '');
        return {} as ChildProcess;
      });

      await expect(stopStdioProcessTree(ROOT_PID)).rejects.toThrow('Refusing');

      expect(killMock).not.toHaveBeenCalled();
      expect(treeKillMock).not.toHaveBeenCalled();
    },
  );

  it.each([-1, 0, 1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, process.pid])(
    'rejects unsafe PID %s without listing or terminating processes',
    async (pid) => {
      await expect(stopStdioProcessTree(pid)).rejects.toThrow(
        'Expected an owned stdio process PID',
      );

      expect(execFileMock).not.toHaveBeenCalled();
      expect(killMock).not.toHaveBeenCalled();
      expect(treeKillMock).not.toHaveBeenCalled();
    },
  );

  it('rejects unsupported platforms without executing commands', async () => {
    setPlatform('unsupported');

    await expect(stopStdioProcessTree(ROOT_PID)).rejects.toThrow('Unsupported platform');

    expect(execFileMock).not.toHaveBeenCalled();
    expect(killMock).not.toHaveBeenCalled();
    expect(treeKillMock).not.toHaveBeenCalled();
  });
});
