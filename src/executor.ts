import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { ExecutorConfig, WorkerResult, WorkflowTask } from "./types.js";
import {
  extractWorkerArtifact,
  parseWorkerPayload,
  reviewWorkerResult,
  reviewWorkerResultForMode,
  summarizeArtifact,
} from "./review.js";

const SDK_INDEX_PATH = "C:/Users/kiala/.config/opencode/node_modules/@opencode-ai/sdk/dist/index.js";

type OpencodeSdkInstance = {
  client: {
    path: {
      get: () => Promise<unknown>;
    };
    session: {
      create: (options?: unknown) => Promise<{ data?: { id: string } }>;
      promptAsync: (options: unknown) => Promise<unknown>;
      status: (options?: unknown) => Promise<{
        data?: Record<string, { type: string; message?: string; attempt?: number; next?: number | null }>;
      }>;
      messages: (options: unknown) => Promise<{
        data?: Array<{
          info: { role: string };
          parts: Array<{ type: string; text?: string }>;
        }>;
      }>;
    };
  };
  server: {
    url: string;
    close(): void;
  };
};

type OpencodeClientOnly = OpencodeSdkInstance["client"];
type SharedServeHandle = {
  client: OpencodeClientOnly;
  instance: OpencodeSdkInstance | null;
  refs: number;
};

const sharedServeHandles = new Map<string, SharedServeHandle>();
const sharedServeInitializers = new Map<string, Promise<SharedServeHandle>>();

function buildWorkerResultOutput(executor: ExecutorConfig, stdout: string): {
  parsed?: WorkerResult["parsed"];
  artifact?: WorkerResult["artifact"];
} {
  const parsedPayload = parseWorkerPayload(stdout);
  if (parsedPayload) {
    return {
      parsed: parsedPayload,
    };
  }

  const artifact = extractWorkerArtifact(stdout);
  if (!artifact) {
    return {};
  }

  const parsed = executor.artifactMode === "text"
    ? summarizeArtifact(artifact)
    : undefined;

  return {
    parsed,
    artifact,
  };
}

function buildWorkerResultOutputForStatus(executor: ExecutorConfig, stdout: string, status: WorkerResult["status"]): {
  parsed?: WorkerResult["parsed"];
  artifact?: WorkerResult["artifact"];
} {
  if (status !== "ok") {
    const parsedPayload = parseWorkerPayload(stdout);
    const artifact = extractWorkerArtifact(stdout);
    return {
      parsed: parsedPayload ?? undefined,
      artifact: artifact ?? undefined,
    };
  }

  return buildWorkerResultOutput(executor, stdout);
}

async function createSdkInstance(port: number): Promise<OpencodeSdkInstance> {
  const indexUrl = pathToFileURL(SDK_INDEX_PATH).href;
  const sdk = await import(indexUrl) as {
    createOpencode: (options?: unknown) => Promise<OpencodeSdkInstance>;
  };

  return sdk.createOpencode({
    hostname: "127.0.0.1",
    port,
    timeout: 10000,
    config: {
      logLevel: "INFO",
    },
  });
}

async function createSdkClient(baseUrl: string): Promise<OpencodeClientOnly> {
  const indexUrl = pathToFileURL(SDK_INDEX_PATH).href;
  const sdk = await import(indexUrl) as {
    createOpencodeClient: (options: { baseUrl: string }) => OpencodeClientOnly;
  };

  return sdk.createOpencodeClient({ baseUrl });
}

async function connectServeClientWhenReady(baseUrl: string, attempts = 20, delayMs = 250): Promise<OpencodeClientOnly> {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const client = await createSdkClient(baseUrl);
      await client.path.get();
      return client;
    } catch (error) {
      lastError = error;
      await sleep(delayMs);
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function acquireServeStartupLock(baseUrl: string): Promise<() => void> {
  const lockRoot = path.join(os.tmpdir(), "codex-workflow");
  mkdirSync(lockRoot, { recursive: true });
  const lockName = baseUrl.replace(/[^a-zA-Z0-9.-]+/g, "_");
  const lockDir = path.join(lockRoot, `${lockName}.lock`);
  const staleMs = 30000;

  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      mkdirSync(lockDir);
      return () => rmSync(lockDir, { recursive: true, force: true });
    } catch {
      try {
        const ageMs = Date.now() - statSync(lockDir).mtimeMs;
        if (ageMs > staleMs) {
          rmSync(lockDir, { recursive: true, force: true });
          continue;
        }
      } catch {
        // If the lock disappeared between checks, retry immediately.
      }
      await sleep(250);
    }
  }

  throw new Error(`Timed out waiting for opencode serve startup lock: ${baseUrl}`);
}

async function acquireServeClient(executor: ExecutorConfig): Promise<{
  key: string;
  client: OpencodeClientOnly;
}> {
  const baseUrl = executor.endpoint ?? "http://127.0.0.1:4196";
  const key = baseUrl;
  const existing = sharedServeHandles.get(key);
  if (existing) {
    existing.refs += 1;
    return { key, client: existing.client };
  }

  const pending = sharedServeInitializers.get(key);
  if (pending) {
    const handle = await pending;
    handle.refs += 1;
    return { key, client: handle.client };
  }

  const initializer = (async (): Promise<SharedServeHandle> => {
    const port = Number(new URL(baseUrl).port || 4196);
    let instance: OpencodeSdkInstance | null = null;
    let client: OpencodeClientOnly;

    try {
      client = await createSdkClient(baseUrl);
      await client.path.get();
    } catch {
      const releaseStartupLock = await acquireServeStartupLock(baseUrl);
      try {
        try {
          client = await createSdkClient(baseUrl);
          await client.path.get();
        } catch {
          try {
            instance = await createSdkInstance(port);
            client = instance.client;
          } catch {
            client = await connectServeClientWhenReady(baseUrl);
          }
        }
      } finally {
        releaseStartupLock();
      }
    }

    const handle: SharedServeHandle = {
      client,
      instance,
      refs: 0,
    };
    sharedServeHandles.set(key, handle);
    return handle;
  })();

  sharedServeInitializers.set(key, initializer);

  try {
    const handle = await initializer;
    handle.refs += 1;
    return { key, client: handle.client };
  } finally {
    sharedServeInitializers.delete(key);
  }
}

function releaseServeClient(key: string): void {
  const existing = sharedServeHandles.get(key);
  if (!existing) {
    return;
  }

  if (existing.refs <= 0) {
    return;
  }

  existing.refs -= 1;
  if (existing.refs > 0) {
    return;
  }

  existing.instance?.server.close();
  sharedServeHandles.delete(key);
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function retryServeCall<T>(
  fn: () => Promise<T>,
  retries: number,
  delayMs: number,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (attempt === retries) {
        break;
      }
      await sleep(delayMs);
    }
  }
  throw lastError;
}

function extractAssistantText(
  messages: Awaited<ReturnType<OpencodeClientOnly["session"]["messages"]>> | undefined,
): string {
  return (messages?.data ?? [])
    .filter((entry) => entry.info.role === "assistant")
    .flatMap((entry) => entry.parts)
    .filter((part) => part.type === "text" && part.text?.trim())
    .map((part) => part.text?.trim() ?? "")
    .join("\n")
    .trim();
}

function parseModel(model?: string): { providerID: string; modelID: string } | undefined {
  if (!model) {
    return undefined;
  }

  const [providerID, ...rest] = model.split("/");
  const modelID = rest.join("/");
  if (!providerID || !modelID) {
    return undefined;
  }

  return { providerID, modelID };
}

function buildServePromptBody(
  executor: ExecutorConfig,
  prompt: string,
): {
  parts: Array<{ type: "text"; text: string }>;
  model?: { providerID: string; modelID: string };
  agent: string;
  system: string;
  tools: Record<string, boolean>;
} {
  return {
    parts: [
      {
        type: "text",
        text: prompt,
      },
    ],
    model: parseModel(executor.model),
    agent: "general",
    system: [
      "Answer the user's request directly in the current workspace.",
      "Inspect or edit repository files when the prompt allows workspace access.",
      "Only claim file edits or verification commands that actually completed.",
      "Do not start subagents.",
      "Return only the final answer requested by the prompt.",
    ].join(" "),
    tools: {
      bash: true,
      read: true,
      list: true,
      glob: true,
      grep: true,
      edit: true,
      write: true,
      apply_patch: false,
      task: false,
      webfetch: false,
      todowrite: false,
      skill: false,
      question: false,
    },
  };
}

async function runServeExecutor(
  executor: ExecutorConfig,
  prompt: string,
): Promise<WorkerResult> {
  const startedAt = new Date().toISOString();
  const { key, client } = await acquireServeClient(executor);
  let latestStatus: { type: string; message?: string; attempt?: number; next?: number | null } | undefined;
  let latestAssistantText = "";
  const timeoutMs = executor.timeoutMs ?? 30000;
  const maxAttempts = Math.max(1, Math.ceil(timeoutMs / 500));

  try {
    const created = await client.session.create({
      body: {
        title: "workflow-mvp-demo",
      },
    });
    const sessionId = created.data?.id;
    if (!sessionId) {
      throw new Error("SDK did not return a session id.");
    }

    await client.session.promptAsync({
      path: { id: sessionId },
      body: buildServePromptBody(executor, prompt),
    });

    let attempts = 0;
    while (attempts < maxAttempts) {
      attempts += 1;
      await sleep(500);
      try {
        const status = await retryServeCall(() => client.session.status(), 2, 250);
        const current = status.data?.[sessionId];
        latestStatus = current;
        if (current?.type === "idle") {
          break;
        }
        const messages = await retryServeCall(
          () => client.session.messages({
            path: { id: sessionId },
            query: { limit: 20 },
          }),
          1,
          250,
        );
        latestAssistantText = extractAssistantText(messages) || latestAssistantText;
        if (!current && latestAssistantText) {
          break;
        }
      } catch (error) {
        try {
          const messages = await retryServeCall(
            () => client.session.messages({
              path: { id: sessionId },
              query: { limit: 20 },
            }),
            1,
            250,
          );
          latestAssistantText = extractAssistantText(messages) || latestAssistantText;
          if (latestAssistantText) {
            break;
          }
        } catch {
          // Keep the original polling failure if no assistant text can be recovered.
        }

        try {
          releaseServeClient(key);
          const reconnected = await acquireServeClient(executor);
          try {
            const status = await retryServeCall(() => reconnected.client.session.status(), 2, 250);
            latestStatus = status.data?.[sessionId];
            const messages = await retryServeCall(
              () => reconnected.client.session.messages({
                path: { id: sessionId },
                query: { limit: 20 },
              }),
              1,
              250,
            );
            latestAssistantText = extractAssistantText(messages) || latestAssistantText;
            if (latestAssistantText) {
              break;
            }
          } finally {
            releaseServeClient(reconnected.key);
          }
        } catch {
          return {
            status: "failed",
            stdout: "[serve lost and reconnect failed]",
            stderr: error instanceof Error ? error.message : String(error),
            exitCode: 1,
            startedAt,
            finishedAt: new Date().toISOString(),
            attempts: 1,
          };
        }
      }
    }

    const messages = await retryServeCall(
      () => client.session.messages({
        path: { id: sessionId },
        query: { limit: 20 },
      }),
      2,
      250,
    );

    const assistantText = extractAssistantText(messages) || latestAssistantText;
    const completed = latestStatus?.type === "idle" || (!latestStatus && Boolean(assistantText));

    if (!completed && !assistantText) {
      return {
        status: "failed",
        stdout: `[serve executor timed out after ${timeoutMs}ms]`,
        stderr: `timeout: ${timeoutMs}ms`,
        exitCode: 1,
        startedAt,
        finishedAt: new Date().toISOString(),
        attempts: 1,
      };
    }

    const statusMessage = latestStatus?.message?.trim();
    const isRetrying = latestStatus?.type === "retry";
    const stdout = assistantText || "[serve executor returned no assistant text]";
    const stderr = statusMessage ?? "";
    const ok = Boolean(assistantText) && !isRetrying && completed;
    const output = buildWorkerResultOutput(executor, stdout);

    return {
      status: ok ? "ok" : "failed",
      stdout,
      stderr,
      exitCode: ok ? 0 : 1,
      startedAt,
      finishedAt: new Date().toISOString(),
      attempts: 1,
      parsed: output.parsed,
      artifact: output.artifact,
    };
  } finally {
    releaseServeClient(key);
  }
}

function isOpencodeIncomplete(stdout: string): boolean {
  const lines = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length === 0) {
    return true;
  }

  return lines.every((line) => {
    try {
      const parsed = JSON.parse(line) as { type?: string };
      return parsed.type === "step_start";
    } catch {
      return false;
    }
  });
}

function normalizeOpencodeOutput(stdout: string): string {
  const lines = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const textParts: string[] = [];
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line) as {
        type?: string;
        part?: { text?: string };
      };
      if (parsed.type === "text" && parsed.part?.text) {
        textParts.push(parsed.part.text);
      }
    } catch {
      // Ignore malformed lines and fall back to raw stdout if nothing is parsed.
    }
  }

  return textParts.length > 0 ? textParts.join("\n") : stdout;
}

function isOpencodeTraceOnly(stdout: string): boolean {
  const normalized = stdout.trim();
  if (!normalized) {
    return false;
  }

  return /("type"\s*:\s*"(?:step_start|step_finish|tool_use)"|"tool"\s*:\s*"(?:read|list|grep|edit|write|bash)"|"sessionID"\s*:|"callID"\s*:|<path>.*<\/path>|<entries>|<content>)/i.test(normalized);
}

function normalizeClaudeOutput(stdout: string): string {
  const lines = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const resultLines: string[] = [];
  const textParts: string[] = [];

  for (const line of lines) {
    try {
      const parsed = JSON.parse(line) as {
        type?: string;
        result?: string;
        message?: {
          content?: Array<{ type?: string; text?: string }>;
        };
      };

      if (parsed.type === "result" && typeof parsed.result === "string" && parsed.result.trim()) {
        resultLines.push(parsed.result.trim());
      }

      for (const part of parsed.message?.content ?? []) {
        if (part.type === "text" && part.text?.trim()) {
          textParts.push(part.text.trim());
        }
      }
    } catch {
      // Ignore malformed lines and fall back to raw stdout if nothing is parsed.
    }
  }

  if (resultLines.length > 0) {
    return resultLines.join("\n");
  }

  if (textParts.length > 0) {
    return textParts.join("\n");
  }

  return stdout;
}

function normalizeExecutorOutput(command: string, stdout: string): string {
  if (command === "opencode") {
    return normalizeOpencodeOutput(stdout);
  }

  if (command === "claude") {
    return normalizeClaudeOutput(stdout);
  }

  return stdout;
}

function candidateWindowsCommands(command: string): string[] {
  if (/[\\/]/.test(command) || path.isAbsolute(command)) {
    const ext = path.extname(command);
    return ext ? [command] : [command, `${command}.exe`, `${command}.cmd`, `${command}.bat`, `${command}.ps1`];
  }

  const pathDirs = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  const names = path.extname(command)
    ? [command]
    : [`${command}.exe`, `${command}.cmd`, `${command}.bat`, `${command}.ps1`, command];
  return pathDirs.flatMap((dir) => names.map((name) => path.join(dir, name)));
}

function resolveWindowsCommand(command: string): string | null {
  for (const candidate of candidateWindowsCommands(command)) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

function resolveNpmCmdExe(cmdPath: string): string | null {
  try {
    const content = readFileSync(cmdPath, "utf8");
    const match = content.match(/"%dp0%\\([^"]+?\.exe)"/i);
    if (!match?.[1]) {
      return null;
    }
    const resolved = path.join(path.dirname(cmdPath), match[1]);
    return existsSync(resolved) ? resolved : null;
  } catch {
    return null;
  }
}

function buildSpawnInvocation(command: string, args: string[], prompt: string): {
  command: string;
  args: string[];
  shell: boolean;
} {
  const spawnArgs = command === "opencode"
    ? prepareOpencodeArgs(args)
    : args;

  if (process.platform !== "win32") {
    return {
      command,
      args: [...spawnArgs, prompt],
      shell: false,
    };
  }

  const promptArg = prompt.replace(/\r?\n/g, " ");
  const resolved = resolveWindowsCommand(command);
  if (!resolved) {
    return {
      command,
      args: [...spawnArgs, promptArg],
      shell: true,
    };
  }

  const ext = path.extname(resolved).toLowerCase();
  if (ext === ".cmd" || ext === ".bat") {
    const npmExe = resolveNpmCmdExe(resolved);
    if (npmExe) {
      return {
        command: npmExe,
        args: [...spawnArgs, promptArg],
        shell: false,
      };
    }
  }

  if (ext === ".ps1") {
    return {
      command: "powershell.exe",
      args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", resolved, ...spawnArgs, promptArg],
      shell: false,
    };
  }

  return {
    command: resolved,
    args: [...spawnArgs, promptArg],
    shell: false,
  };
}

export function prepareOpencodeArgs(args: string[]): string[] {
  return withOpencodeWorkDir(withOpencodeTitle(normalizeOpencodeModelArgs(args)));
}

export function normalizeOpencodeModelArgs(args: string[]): string[] {
  const modelAliases = new Map([
    ["openrouter/xiaomi/mimo-v2.5:free", "opencode/mimo-v2.5-free"],
  ]);

  return args.map((arg, index) => {
    if (index > 0 && args[index - 1] === "--model") {
      return modelAliases.get(arg) ?? arg;
    }
    return arg;
  });
}

export function withOpencodeTitle(args: string[]): string[] {
  if (!args.includes("run") || args.includes("--title")) {
    return args;
  }

  return [...args, "--title", "codex-workflow-task"];
}

export function withOpencodeWorkDir(args: string[]): string[] {
  const callerDir = process.env.CODEX_WORKFLOW_CALLER_CWD?.trim();
  if (!callerDir || args.includes("--dir")) {
    return args;
  }

  const workDir = isGitWorkTree(callerDir)
    ? callerDir
    : ensureOpencodeScratchDir();

  return [...args, "--dir", workDir];
}

function isGitWorkTree(dir: string): boolean {
  if (!existsSync(dir)) {
    return false;
  }

  const result = spawnSync("git", ["-C", dir, "rev-parse", "--is-inside-work-tree"], {
    encoding: "utf8",
    windowsHide: true,
  });
  return result.status === 0 && result.stdout.trim() === "true";
}

function ensureOpencodeScratchDir(): string {
  const scratchDir = path.join(os.homedir(), ".codex", "codex-workflow", "opencode-scratch");
  mkdirSync(scratchDir, { recursive: true });

  if (!isGitWorkTree(scratchDir)) {
    spawnSync("git", ["-C", scratchDir, "init"], {
      encoding: "utf8",
      windowsHide: true,
    });
  }

  return scratchDir;
}

export function normalizeExecutorFailure(
  command: string,
  stdout: string,
  stderr: string,
  exitCode: number,
): Pick<WorkerResult, "status" | "stdout" | "stderr" | "exitCode" | "failureCategory"> {
  const normalizedStdout = normalizeExecutorOutput(command, stdout);

  if (command === "opencode" && isOpencodeTraceOnly(normalizedStdout)) {
    return {
      status: "failed",
      stdout: normalizedStdout,
      stderr: [stderr, "opencode returned an event stream or tool trace instead of a final artifact"].filter(Boolean).join("\n"),
      exitCode: exitCode === 0 ? 1 : exitCode,
      failureCategory: "invalid-json",
    };
  }

  return {
    status: exitCode === 0 ? "ok" : "failed",
    stdout: normalizedStdout,
    stderr,
    exitCode,
  };
}

export function shouldRetryExecutor(
  executor: ExecutorConfig,
  result: WorkerResult,
  retryPrompt?: string,
  expectedOutput: "schema" | "artifact" = "artifact",
  structuredMode?: WorkflowTask["structuredMode"],
): boolean {
  if (executor.mode === "serve") {
    return false;
  }

  if (!retryPrompt) {
    return false;
  }

  if (executor.command === "opencode" && isOpencodeIncomplete(result.stdout)) {
    return true;
  }

  const review = structuredMode || expectedOutput !== "artifact"
    ? reviewWorkerResultForMode(result, expectedOutput, structuredMode)
    : reviewWorkerResult(result);
  return review.decision !== "accept";
}

async function runExecutorOnce(
  executor: ExecutorConfig,
  prompt: string,
): Promise<WorkerResult> {
  if (executor.mode === "serve") {
    return runServeExecutor(executor, prompt);
  }

  const startedAt = new Date().toISOString();

  return new Promise((resolve) => {
    const invocation = buildSpawnInvocation(executor.command, executor.args, prompt);
    const child = spawn(invocation.command, invocation.args, {
      shell: invocation.shell,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const timeoutMs = executor.timeoutMs ?? 300000;
    let timedOut = false;

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });

    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });

    const timer = setTimeout(() => {
      timedOut = true;
      stderr = `${stderr}\ntimeout: ${timeoutMs}ms`.trim();
      child.kill("SIGTERM");
      setTimeout(() => {
        if (!child.killed) {
          child.kill("SIGKILL");
        }
      }, 5000);
    }, timeoutMs);

    child.on("error", (error) => {
      clearTimeout(timer);
      const normalized = normalizeExecutorFailure(executor.command, stdout, `${stderr}\n${error.message}`.trim(), -1);
      const output = buildWorkerResultOutputForStatus(executor, normalized.stdout, normalized.status);
      resolve({
        status: normalized.status,
        stdout: normalized.stdout,
        stderr: normalized.stderr,
        exitCode: normalized.exitCode,
        startedAt,
        finishedAt: new Date().toISOString(),
        attempts: 1,
        parsed: output.parsed,
        artifact: output.artifact,
        failureCategory: normalized.failureCategory,
      });
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      const normalized = normalizeExecutorFailure(executor.command, stdout, stderr, code ?? -1);
      const resultStatus = timedOut ? "failed" : normalized.status;
      const resultStdout = timedOut ? `[spawn executor timed out after ${timeoutMs}ms]` : normalized.stdout;
      const output = buildWorkerResultOutputForStatus(executor, resultStdout, resultStatus);
      resolve({
        status: resultStatus,
        stdout: resultStdout,
        stderr: timedOut ? stderr : normalized.stderr,
        exitCode: timedOut ? (code ?? -1) : normalized.exitCode,
        startedAt,
        finishedAt: new Date().toISOString(),
        attempts: 1,
        parsed: output.parsed,
        artifact: output.artifact,
        failureCategory: timedOut ? undefined : normalized.failureCategory,
      });
    });
  });
}

export async function runExecutor(
  executor: ExecutorConfig,
  prompt: string,
  retryPrompt?: string,
  expectedOutput: "schema" | "artifact" = "artifact",
  structuredMode?: WorkflowTask["structuredMode"],
): Promise<WorkerResult> {
  const first = await runExecutorOnce(executor, prompt);

  if (!shouldRetryExecutor(executor, first, retryPrompt, expectedOutput, structuredMode)) {
    return first;
  }

  const second = await runExecutorOnce(executor, retryPrompt ?? prompt);
  return {
    ...second,
    attempts: 2,
  };
}
