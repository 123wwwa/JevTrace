import { spawn, type ChildProcess } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';

/**
 * Runs the MCP server as a child process behind the stdio connection the host opened, so the server can be
 * restarted without the host noticing. MCP hosts start a stdio server once and do not start it again when it
 * exits (Claude Code leaves it failed until `/mcp` reconnects), and a key entered again with `jevtrace setup`
 * should take effect as a fresh server, not as a patched one.
 *
 * Messages are relayed line by line (MCP's stdio framing is one JSON-RPC message per line). The host's
 * `initialize` request and `notifications/initialized` are kept and replayed to a new worker, whose answer to
 * the replay is not passed on: the host's session simply continues. A worker is replaced only between requests,
 * when the stamp (the saved provider settings) has changed; a worker that exits on its own answers its open
 * requests with an error and is started again by the next request.
 */
export interface SupervisorOptions {
  /** The worker: the same CLI started as the MCP server itself. */
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  /** Changes when the worker must be restarted; read when a request arrives. */
  stamp: () => string;
  input?: Readable;
  output?: Writable;
  /** Diagnostics, for the host's log (stderr), never the protocol stream. */
  log?: (message: string) => void;
}

type Id = string | number;
interface Message { id?: Id | null; method?: string; params?: { requestId?: Id } }
interface Worker {
  process: ChildProcess;
  stamp: string;
  /** False while the replayed `initialize` is unanswered; host messages wait in `queue` meanwhile. */
  ready: boolean;
  queue: string[];
  replayId?: string;
  retired: boolean;
}

/** Calls `onLine` for each complete line of a stream. */
function lines(stream: Readable, onLine: (line: string) => void): void {
  let buffer = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk: string) => {
    buffer += chunk;
    for (let index = buffer.indexOf('\n'); index >= 0; index = buffer.indexOf('\n')) {
      const line = buffer.slice(0, index).replace(/\r$/, '');
      buffer = buffer.slice(index + 1);
      if (line.trim()) onLine(line);
    }
  });
}

const parse = (line: string): Message | undefined => {
  try {
    const value = JSON.parse(line) as unknown;
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Message : undefined;
  } catch {
    return undefined;
  }
};
const isRequest = (message: Message | undefined): message is Message & { id: Id; method: string } =>
  message?.method !== undefined && message.id !== undefined && message.id !== null;
const isResponse = (message: Message | undefined): message is Message & { id: Id } =>
  message !== undefined && message.method === undefined && message.id !== undefined && message.id !== null;

/** Resolves with the exit code once the host has closed the connection and the worker has stopped. */
export function superviseStdio(options: SupervisorOptions): Promise<number> {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const log = options.log ?? (() => undefined);
  let worker: Worker | undefined;
  let initialize: string | undefined;
  let initialized: string | undefined;
  let restarts = 0;
  let closing = false;
  /** Host requests the current worker has not answered, by serialized id. */
  const pending = new Map<string, Id>();
  const key = (id: Id) => JSON.stringify(id);
  let finish!: (code: number) => void;
  const done = new Promise<number>(resolve => { finish = resolve; });

  output.on('error', () => undefined);
  const toHost = (line: string) => { output.write(line + '\n'); };
  const toWorker = (current: Worker, line: string) => { current.process.stdin?.write(line + '\n'); };

  const start = (): Worker => {
    const child = spawn(options.command, options.args, { env: options.env, stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true });
    const current: Worker = { process: child, stamp: options.stamp(), ready: initialize === undefined, queue: [], retired: false };
    worker = current;
    // Writing to a worker that has just died raises EPIPE here; its exit is handled below.
    child.stdin?.on('error', () => undefined);
    if (child.stdout) lines(child.stdout, line => fromWorker(current, line));
    child.on('error', error => {
      log(`could not start the server process: ${error.message}`);
      exited(current, null, null);
    });
    child.on('exit', (code, signal) => exited(current, code, signal));
    if (initialize !== undefined) {
      current.replayId = `jevtrace-supervisor-initialize-${++restarts}`;
      toWorker(current, JSON.stringify({ ...JSON.parse(initialize), id: current.replayId }));
    }
    return current;
  };

  const retire = (current: Worker) => {
    current.retired = true;
    if (worker === current) worker = undefined;
    current.process.stdin?.end();
    // A worker with nothing in flight exits once its input ends; this only covers one that does not.
    setTimeout(() => { if (current.process.exitCode === null) current.process.kill(); }, 3000).unref();
  };

  const fromWorker = (current: Worker, line: string) => {
    if (current.retired) return;
    const message = parse(line);
    if (current.replayId !== undefined && isResponse(message) && message.id === current.replayId) {
      current.replayId = undefined;
      current.ready = true;
      if (initialized !== undefined) toWorker(current, initialized);
      for (const queued of current.queue.splice(0)) toWorker(current, queued);
      return;
    }
    if (isResponse(message)) pending.delete(key(message.id));
    toHost(line);
  };

  const exited = (current: Worker, code: number | null, signal: NodeJS.Signals | null) => {
    if (current.retired) return;
    current.retired = true;
    if (worker === current) worker = undefined;
    if (closing) { finish(0); return; }
    for (const id of pending.values()) {
      toHost(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32603, message: 'The JevTrace server process stopped before answering; call the tool again to start it anew.' } }));
    }
    pending.clear();
    log(`the server process stopped (${signal ?? `exit code ${code}`}); the next call starts it again`);
  };

  const fromHost = (line: string) => {
    const message = parse(line);
    if (isRequest(message) && message.method !== 'initialize') {
      // Between requests only, so no answer is lost: a restart while a call is running would drop it.
      if (worker && pending.size === 0 && worker.ready && worker.stamp !== options.stamp()) {
        log('the saved provider settings changed; restarting the JevTrace server with them');
        retire(worker);
      }
    }
    const current = worker ?? start();
    if (isRequest(message)) pending.set(key(message.id), message.id);
    // A cancelled request is never answered (MCP), so it must not hold back a restart.
    if (message?.method === 'notifications/cancelled' && message.params?.requestId !== undefined) pending.delete(key(message.params.requestId));
    if (current.ready) toWorker(current, line);
    else current.queue.push(line);
    // Recorded after forwarding, so a worker started for this very message does not get it twice.
    if (isRequest(message) && message.method === 'initialize') initialize = line;
    else if (message?.method === 'notifications/initialized') initialized = line;
  };

  lines(input, fromHost);
  input.on('end', () => {
    closing = true;
    if (!worker) { finish(0); return; }
    worker.process.stdin?.end();
  });
  start();
  return done;
}
