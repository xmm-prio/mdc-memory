/**
 * Scripted stand-in for the dsh `subprocess` service. It emulates the three
 * external programs the Host runs (uv sync, the embedding model download and
 * `basic-memory serve`) and records every spawn so tests can assert on the
 * contract with those programs. Tests override a program to inject failures
 * or to hold it at a gate.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { dirname, isAbsolute, join } from 'node:path';
import { PassThrough } from 'node:stream';

const FAKE_PATH_DIR = isAbsolute('C:\\') ? 'C:\\fake-bin' : '/fake-bin';
const PIPE_LAG_MS = 30;

/** Which emulated program an argv runs. */
function programOf(argv) {
  if (argv.includes('uv') && argv.includes('sync')) return 'uvSync';
  if (argv[1] === '-c') return 'model';
  if (argv.includes('serve')) return 'serve';
  throw new Error(`fake subprocess: unknown program ${argv.join(' ')}`);
}

function argValue(argv, flag) {
  const at = argv.indexOf(flag);
  return at === -1 ? undefined : argv[at + 1];
}

/** uv sync: materialize the venv interpreter like a real sync would. */
async function uvSync(proc) {
  const venv = proc.spec.env.UV_PROJECT_ENVIRONMENT;
  const python = process.platform === 'win32' ? join(venv, 'Scripts', 'python.exe') : join(venv, 'bin', 'python');
  mkdirSync(dirname(python), { recursive: true });
  writeFileSync(python, '');
  proc.stderr('Resolved 120 packages');
  proc.stderr('Installed 120 packages');
  return 0;
}

async function model(proc) {
  proc.stdout('model ready');
  return 0;
}

/** basic-memory serve: answer the REST health route until terminated. */
async function serve(proc) {
  const server = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ projects: [], default_project: 'main' }));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(Number(argValue(proc.spec.argv, '--port')), argValue(proc.spec.argv, '--host'), resolve);
  });
  proc.stderr('INFO:     Uvicorn running');
  await proc.terminated;
  await new Promise((resolve) => server.close(resolve));
  server.closeAllConnections();
  return 1;
}

const DEFAULT_PROGRAMS = { uvSync, model, serve };

class FakeProcess {
  constructor(spec, program) {
    this.spec = spec;
    this.program = program;
    this.wasTerminated = false;
    this.exited = false;
    this.streams = { stdout: new PassThrough(), stderr: new PassThrough() };
    this.terminated = new Promise((resolve) => { this.onTerminate = resolve; });
    let settle;
    this.done = new Promise((resolve) => { settle = resolve; });
    this.settle = (exitCode) => {
      if (this.exited) return;
      this.exited = true;
      settle({ exitCode, signal: null });
      // Like a real pipe, buffered output may still arrive after the exit is reported.
      setTimeout(() => {
        this.streams.stdout.end();
        this.streams.stderr.end();
      }, PIPE_LAG_MS);
    };
    spec.signal?.addEventListener('abort', () => this.terminate(), { once: true });
  }

  stdout(line) { this.write(this.streams.stdout, line); }

  stderr(line) { this.write(this.streams.stderr, line); }

  write(stream, line) {
    setTimeout(() => stream.write(`${line}\n`), PIPE_LAG_MS / 2);
  }

  /** Simulate the process dying on its own (crash) with the given exit code. */
  crash(exitCode = 1) {
    this.settle(exitCode);
    this.onTerminate();
  }

  terminate() {
    if (this.exited) return;
    this.wasTerminated = true;
    this.onTerminate();
    // Programs that ignore termination (a held gate) still die, as a Job kill would.
    setTimeout(() => this.settle(1), 50);
  }

  handle() {
    return {
      stdin: undefined,
      stdout: this.streams.stdout,
      stderr: this.streams.stderr,
      control: undefined,
      collected: {},
      done: this.done,
      terminate: () => this.terminate(),
      waitForExit: async () => { await this.done; return true; },
    };
  }
}

/**
 * @param {Partial<Record<'uvSync'|'model'|'serve', (proc: FakeProcess) => Promise<number>>>} [overrides]
 * @param {object} [options]
 * @param {string[]} [options.missingExecutables] - bare names that fail PATH lookup.
 */
export function createFakeSubprocess(overrides = {}, { missingExecutables = [] } = {}) {
  const programs = { ...DEFAULT_PROGRAMS, ...overrides };
  const spawned = [];
  return {
    spawned,
    /** The most recent process running the given program. */
    last: (program) => spawned.findLast((proc) => proc.program === program),
    async resolveExecutable(command) {
      if (isAbsolute(command)) {
        if (!existsSync(command)) throw notFound(`command ${JSON.stringify(command)} is not an executable file`);
        return command;
      }
      if (missingExecutables.includes(command)) throw notFound(`command ${JSON.stringify(command)} was not found on PATH`);
      return join(FAKE_PATH_DIR, `${command}.exe`);
    },
    spawn(spec) {
      if (!isAbsolute(spec.argv[0])) throw new Error(`fake subprocess: argv[0] must be absolute, got ${spec.argv[0]}`);
      if (!existsSync(spec.cwd)) throw new Error(`fake subprocess: cwd does not exist: ${spec.cwd}`);
      const program = programOf(spec.argv);
      const proc = new FakeProcess(spec, program);
      spawned.push(proc);
      programs[program](proc).then((code) => proc.settle(code), () => proc.settle(1));
      return proc.handle();
    },
  };
}

function notFound(message) {
  const error = new Error(`subprocess-local: ${message}`);
  error.name = 'SubprocessExecutableNotFoundError';
  return error;
}

/** A manually released barrier for holding an emulated program mid-run. */
export function createGate() {
  let open;
  const opened = new Promise((resolve) => { open = resolve; });
  return { opened, open };
}
