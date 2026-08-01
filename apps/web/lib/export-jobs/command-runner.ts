import { spawn } from "node:child_process";

export class CommandError extends Error {
  constructor(
    message: string,
    readonly exitCode: number | null,
    readonly stderr: string,
  ) {
    super(message);
    this.name = "CommandError";
  }
}

interface RunCommandOptions {
  cwd: string;
  onLine: (line: string) => Promise<void>;
  timeoutMs?: number;
}

export async function runNodeCommand(
  scriptPath: string,
  args: readonly string[],
  options: RunCommandOptions,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath, ...args], {
      cwd: options.cwd,
      env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" },
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    let timedOut = false;
    let forceKillTimer: ReturnType<typeof setTimeout> | undefined;
    const timeoutMs = options.timeoutMs ?? 10 * 60 * 1_000;
    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      forceKillTimer = setTimeout(() => child.kill("SIGKILL"), 5_000);
    }, timeoutMs);
    const clearKillTimers = () => {
      clearTimeout(timeoutTimer);
      if (forceKillTimer) clearTimeout(forceKillTimer);
    };
    let pendingWrites = Promise.resolve();
    const lineBuffers = { stdout: "", stderr: "" };

    const capture = (source: "stdout" | "stderr", chunk: Buffer) => {
      const text = chunk.toString("utf8");
      if (source === "stderr") stderr = `${stderr}${text}`.slice(-12_000);
      const parts = `${lineBuffers[source]}${text}`.split(/\r?\n/);
      lineBuffers[source] = parts.pop() ?? "";
      for (const rawLine of parts) {
        const line = rawLine.trim();
        if (!line) continue;
        pendingWrites = pendingWrites.then(() => options.onLine(line));
      }
    };

    const flushBuffers = () => {
      for (const source of ["stdout", "stderr"] as const) {
        const line = lineBuffers[source].trim();
        if (line) pendingWrites = pendingWrites.then(() => options.onLine(line));
      }
    };

    child.stdout.on("data", (chunk: Buffer) => capture("stdout", chunk));
    child.stderr.on("data", (chunk: Buffer) => capture("stderr", chunk));
    child.on("error", (error) => {
      clearKillTimers();
      reject(error);
    });
    child.on("close", (code, signal) => {
      clearKillTimers();
      flushBuffers();
      void pendingWrites.then(() => {
        if (timedOut) {
          reject(new CommandError(`Exporter exceeded its ${Math.round(timeoutMs / 1_000)} second time limit.`, code, stderr));
          return;
        }
        if (code === 0) {
          resolve();
          return;
        }
        const lastLine = stderr.trim().split(/\r?\n/).at(-1);
        reject(
          new CommandError(
            lastLine || `Exporter process stopped${signal ? ` (${signal})` : ""}.`,
            code,
            stderr,
          ),
        );
      }, reject);
    });
  });
}
