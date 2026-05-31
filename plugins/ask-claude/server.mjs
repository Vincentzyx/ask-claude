#!/usr/bin/env node
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod/v4";

const require = createRequire(import.meta.url);
const HOME = process.env.HOME || os.homedir() || process.cwd();
const DEFAULT_CWD = path.resolve(process.env.ASK_CLAUDE_DEFAULT_CWD || process.cwd());
const REGISTRY_DIR = process.env.ASK_CLAUDE_REGISTRY_DIR ||
  path.join(HOME, ".codex", "ask-claude");
const REGISTRY_FILE = path.join(REGISTRY_DIR, "sessions.json");
const DEFAULT_ACP_ADAPTER = resolveDefaultAcpAdapter();
const ACP_COMMAND = process.env.CLAUDE_ACP_COMMAND || DEFAULT_ACP_ADAPTER.command;
const ACP_ARGS = process.env.CLAUDE_ACP_ARGS
  ? JSON.parse(process.env.CLAUDE_ACP_ARGS)
  : process.env.CLAUDE_ACP_COMMAND
    ? []
    : DEFAULT_ACP_ADAPTER.args;

const MAX_ANSWER_CHARS = 80_000;
let DEFAULT_TIMEOUT_MS = envDurationMs("ASK_CLAUDE_PROMPT_TIMEOUT_MS", 15 * 60 * 1000);
let ACP_INIT_TIMEOUT_MS = envDurationMs("ASK_CLAUDE_INIT_TIMEOUT_MS", 60_000);
let ACP_CONFIG_TIMEOUT_MS = envDurationMs("ASK_CLAUDE_CONFIG_TIMEOUT_MS", 60_000);
let ACP_RESUME_TIMEOUT_MS = envDurationMs("ASK_CLAUDE_RESUME_TIMEOUT_MS", 15 * 60 * 1000);
let ACP_LOAD_TIMEOUT_MS = envDurationMs("ASK_CLAUDE_LOAD_TIMEOUT_MS", 15 * 60 * 1000);
const CACHE_COLD_MS = 60 * 60 * 1000;
const LARGE_CONTEXT_TOKENS = 50_000;
const PROGRESS_HEARTBEAT_MS = 5_000;
const PROGRESS_MIN_INTERVAL_MS = 2_000;
const PROGRESS_CHAR_DELTA = 500;
const ADAPTER_SHUTDOWN_GRACE_MS = 2_000;
const MODEL_VALUES = ["default", "sonnet[1m]", "opus", "haiku"];
const EFFORT_VALUES = ["default", "low", "medium", "high", "xhigh", "max"];
const MODE_VALUES = ["auto", "default", "acceptEdits", "plan", "dontAsk", "bypassPermissions"];
const PERMISSION_POLICY_VALUES = [
  "readonly",
  "allow_edits",
  "allow_commands",
  "allow_edits_and_commands",
  "allow_all",
];
const DEFAULT_MODEL = envEnum("ASK_CLAUDE_DEFAULT_MODEL", MODEL_VALUES, undefined);
const DEFAULT_EFFORT = envEnum("ASK_CLAUDE_DEFAULT_EFFORT", EFFORT_VALUES, undefined);
const DEFAULT_MODE = envEnum("ASK_CLAUDE_DEFAULT_MODE", MODE_VALUES, undefined);
const DEFAULT_PERMISSION_POLICY =
  envEnum("ASK_CLAUDE_DEFAULT_PERMISSION_POLICY", PERMISSION_POLICY_VALUES, "readonly");

function log(...args) {
  console.error("[ask-claude]", ...args);
}

function codedError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function isAbortLike(error) {
  return error?.code === "ASK_CLAUDE_CANCELLED" ||
    error?.name === "AbortError" ||
    error?.message === "Request was cancelled";
}

function shouldRestartAdapter(error) {
  return error?.code === "ASK_CLAUDE_TIMEOUT" || isAbortLike(error);
}

function throwIfAborted(signal) {
  if (signal?.aborted) {
    throw codedError("Request was cancelled", "ASK_CLAUDE_CANCELLED");
  }
}

function resolveDefaultAcpAdapter() {
  try {
    const packageJsonPath = require.resolve("@agentclientprotocol/claude-agent-acp/package.json");
    const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
    const bin = typeof packageJson.bin === "string"
      ? packageJson.bin
      : packageJson.bin?.["claude-agent-acp"];
    if (bin) {
      return {
        command: process.execPath,
        args: [path.resolve(path.dirname(packageJsonPath), bin)],
      };
    }
  } catch {
    // Fall through to npx so source checkouts without installed dependencies still have a useful default.
  }
  return {
    command: "npx",
    args: ["-y", "@agentclientprotocol/claude-agent-acp"],
  };
}

function envDurationMs(name, fallbackMs) {
  const raw = process.env[name];
  if (!raw) return fallbackMs;
  const trimmed = raw.trim();
  const parsed = Number(trimmed);
  if (Number.isFinite(parsed) && parsed > 0) return Math.floor(parsed);
  const match = trimmed.match(/^(\d+(?:\.\d+)?)\s*(ms|s|m|h)$/i);
  if (match) {
    const value = Number(match[1]);
    const unit = match[2].toLowerCase();
    const multiplier = unit === "ms" ? 1 : unit === "s" ? 1000 : unit === "m" ? 60_000 : 3_600_000;
    if (Number.isFinite(value) && value > 0) return Math.floor(value * multiplier);
  }
  log(`ignoring invalid ${name}=${raw}; using ${fallbackMs}`);
  return fallbackMs;
}

function envEnum(name, values, fallback) {
  const raw = process.env[name];
  if (!raw) return fallback;
  if (values.includes(raw)) return raw;
  log(`ignoring invalid ${name}=${raw}; expected one of ${values.join(", ")}`);
  return fallback;
}

function refreshTimeoutConfig() {
  DEFAULT_TIMEOUT_MS = envDurationMs("ASK_CLAUDE_PROMPT_TIMEOUT_MS", 15 * 60 * 1000);
  ACP_INIT_TIMEOUT_MS = envDurationMs("ASK_CLAUDE_INIT_TIMEOUT_MS", 60_000);
  ACP_CONFIG_TIMEOUT_MS = envDurationMs("ASK_CLAUDE_CONFIG_TIMEOUT_MS", 60_000);
  ACP_RESUME_TIMEOUT_MS = envDurationMs("ASK_CLAUDE_RESUME_TIMEOUT_MS", 15 * 60 * 1000);
  ACP_LOAD_TIMEOUT_MS = envDurationMs("ASK_CLAUDE_LOAD_TIMEOUT_MS", 15 * 60 * 1000);
}

function truncate(value, maxChars = 4000) {
  if (value == null) return "";
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n...[truncated ${text.length - maxChars} chars]`;
}

function preview(value, maxChars = 1000) {
  return truncate(String(value || "").replace(/\s+/g, " ").trim(), maxChars);
}

function ageInfo(isoTime) {
  if (!isoTime) return { age_ms: null, cache_likely_cold: true };
  const ageMs = Date.now() - new Date(isoTime).getTime();
  return {
    age_ms: ageMs,
    age_minutes: ageMs / 60_000,
    cache_likely_cold: ageMs > CACHE_COLD_MS,
  };
}

function absCwd(cwd) {
  return path.resolve(cwd || DEFAULT_CWD);
}

function usageSummary(usage) {
  if (!usage || typeof usage.used !== "number" || typeof usage.size !== "number") {
    return {
      text: "Context: unavailable",
      warning: null,
      usage: null,
    };
  }
  const remaining = usage.size - usage.used;
  const percent = usage.size > 0 ? (usage.used / usage.size) * 100 : 0;
  let warning = null;
  if (percent >= 95) {
    warning = "Context is above 95%; start a new Claude session or summarize before continuing.";
  } else if (percent >= 90) {
    warning = "Context is above 90%; avoid adding large files unless necessary.";
  } else if (percent >= 75) {
    warning = "Context is above 75%; keep the next prompt focused.";
  }
  const costText = usage.cost
    ? `, cost=${usage.cost.amount} ${usage.cost.currency}`
    : "";
  return {
    text: `Context: ${usage.used}/${usage.size} tokens (${percent.toFixed(1)}%, remaining ${remaining})${costText}`,
    warning,
    usage: {
      ...usage,
      remaining,
      percent,
    },
  };
}

function makeProgressReporter(extra, label) {
  const progressToken = extra?._meta?.progressToken;
  let lastMessage = "";
  return (status = {}, force = false) => {
    const elapsed = status.startedAt ? Math.round((Date.now() - status.startedAt) / 1000) : 0;
    const usageText = status.usage?.used && status.usage?.size
      ? `, context ${status.usage.used}/${status.usage.size}`
      : "";
    const toolText = status.toolTitle
      ? `, tool: ${status.toolTitle}`
      : status.toolCount
        ? `, tools ${status.toolCount}`
        : "";
    const message = `${label}: ${status.phase || "running"}, ${status.charCount || 0} chars${toolText}${usageText}, ${elapsed}s`;
    if (!force && message === lastMessage) return;
    lastMessage = message;

    if (progressToken != null && extra?.sendNotification) {
      extra.sendNotification({
        method: "notifications/progress",
        params: {
          progressToken,
          progress: Math.max(status.charCount || elapsed || 0, 0),
          message,
        },
      }).catch((error) => log("progress notification failed:", error.message));
      return;
    }

    server.sendLoggingMessage({
      level: "info",
      logger: "ask-claude",
      data: { message, ...status, has_response_text: (status.charCount || 0) > 0 },
    }).catch(() => {});
  };
}

function asTextResult(text, structuredContent = undefined) {
  const result = { content: [{ type: "text", text }] };
  if (structuredContent !== undefined) result.structuredContent = structuredContent;
  return result;
}

function normalizePermissionPolicy(policy) {
  return policy || DEFAULT_PERMISSION_POLICY;
}

function choosePermissionOption(request, policy) {
  const options = request.params?.options || [];
  const toolCall = request.params?.toolCall || {};
  const kind = String(toolCall.kind || "").toLowerCase();
  const title = String(toolCall.title || "").toLowerCase();
  const rawInput = toolCall.rawInput || {};
  const toolName = String(toolCall._meta?.claudeCode?.toolName || "").toLowerCase();
  const isEdit =
    kind.includes("edit") ||
    kind.includes("write") ||
    title.includes("edit") ||
    title.includes("write") ||
    toolName.includes("edit") ||
    toolName.includes("write") ||
    rawInput.file_path ||
    rawInput.new_string;
  const isExecute =
    kind.includes("execute") ||
    kind.includes("terminal") ||
    title.includes("bash") ||
    title.includes("shell") ||
    toolName.includes("bash");

  const allowOnce = options.find((option) => option.kind === "allow_once");
  const allowAlways = options.find((option) => option.kind === "allow_always");
  const allowAny = options.find((option) => String(option.optionId).includes("allow"));
  const reject = options.find((option) => option.kind === "reject_once") ||
    options.find((option) => String(option.optionId).includes("reject"));

  let allow = false;
  if (policy === "allow_all") allow = true;
  if (policy === "allow_edits" && isEdit && !isExecute) allow = true;
  if (policy === "allow_commands" && isExecute && !isEdit) allow = true;
  if (policy === "allow_edits_and_commands" && (isEdit || isExecute)) allow = true;

  if (allow) {
    const chosen = allowOnce || allowAlways || allowAny;
    if (chosen) return { outcome: { outcome: "selected", optionId: chosen.optionId } };
  }

  if (reject) return { outcome: { outcome: "selected", optionId: reject.optionId } };
  return { outcome: { outcome: "cancelled" } };
}

class ClaudeAcpBridge {
  constructor() {
    this.child = null;
    this.buffer = "";
    this.nextId = 1;
    this.pending = new Map();
    this.sessions = new Map();
    this.sessionsByKey = new Map();
    this.activeCollectors = new Map();
    this.startPromise = null;
    this.registryLoaded = false;
    this.registry = { version: 1, sessions: {} };
  }

  async ensureRegistryLoaded() {
    if (this.registryLoaded) return;
    await mkdir(REGISTRY_DIR, { recursive: true });
    try {
      const text = await readFile(REGISTRY_FILE, "utf8");
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed === "object" && parsed.sessions) {
        this.registry = parsed;
      }
    } catch (error) {
      if (error.code !== "ENOENT") {
        log("failed to read registry:", error.message);
      }
    }
    this.registryLoaded = true;
  }

  async persistRegistry() {
    await this.ensureRegistryLoaded();
    await mkdir(REGISTRY_DIR, { recursive: true });
    const tmp = `${REGISTRY_FILE}.${process.pid}.tmp`;
    await writeFile(tmp, `${JSON.stringify(this.registry, null, 2)}\n`, "utf8");
    await rename(tmp, REGISTRY_FILE);
  }

  async upsertRegistryEntry(session, patch = {}) {
    await this.ensureRegistryLoaded();
    const existing = this.registry.sessions[session.id] || {};
    const latestUsage = patch.latest_usage || session.latestUsage || existing.latest_usage || null;
    this.registry.sessions[session.id] = {
      ...existing,
      session_id: session.id,
      session_key: session.key,
      cwd: session.cwd,
      created_at: existing.created_at || session.createdAt,
      last_active_at: patch.last_active_at || existing.last_active_at || session.createdAt,
      permission_policy: session.permissionPolicy,
      latest_usage: latestUsage,
      title: patch.title || existing.title || session.title,
      active: false,
      turns: patch.turn
        ? [...(existing.turns || []), patch.turn].slice(-40)
        : existing.turns || [],
      warnings: patch.warnings || existing.warnings || [],
    };
    await this.persistRegistry();
  }

  async markRegistryInactive(sessionId) {
    await this.ensureRegistryLoaded();
    const entry = this.registry.sessions[sessionId];
    if (entry) {
      entry.active = false;
      await this.persistRegistry();
    }
  }

  async ensureStarted() {
    if (this.child && !this.child.killed) return;
    if (this.startPromise) return this.startPromise;

    this.startPromise = new Promise((resolve, reject) => {
      log("starting ACP adapter:", ACP_COMMAND, ACP_ARGS.join(" "));
      const child = spawn(ACP_COMMAND, ACP_ARGS, {
        cwd: DEFAULT_CWD,
        stdio: ["pipe", "pipe", "pipe"],
        env: process.env,
        detached: process.platform !== "win32",
      });
      this.child = child;
      this.buffer = "";

      child.stdout.on("data", (data) => this.handleStdout(data));
      child.stderr.on("data", (data) => log("adapter stderr:", data.toString().trimEnd()));
      child.on("exit", (code, signal) => {
        log("adapter exited", { code, signal });
        for (const { reject: rejectPending, timer } of this.pending.values()) {
          clearTimeout(timer);
          rejectPending(new Error(`ACP adapter exited: code=${code} signal=${signal}`));
        }
        this.pending.clear();
        this.activeCollectors.clear();
        for (const session of this.sessions.values()) {
          this.markRegistryInactive(session.id).catch((error) => log("registry inactive failed:", error.message));
        }
        this.sessions.clear();
        this.sessionsByKey.clear();
        this.child = null;
        this.startPromise = null;
      });

      this.send("initialize", {
        protocolVersion: 1,
        clientCapabilities: {},
        clientInfo: {
          name: "ask-claude",
          title: "Ask Claude MCP",
          version: "0.1.0",
        },
      }, ACP_INIT_TIMEOUT_MS).then((result) => {
        this.agentInfo = result.agentInfo;
        this.agentCapabilities = result.agentCapabilities;
        log("adapter initialized", result.agentInfo || {});
        resolve();
      }).catch((error) => {
        this.stopAdapter(`initialize failed: ${error.message}`).finally(() => reject(error));
      });
    });

    return this.startPromise;
  }

  async stopAdapter(reason = "stop") {
    const child = this.child;
    if (!child || child.killed) return;
    log("stopping ACP adapter:", reason);
    const targetPid = child.pid;
    const killTarget = process.platform === "win32" ? targetPid : -targetPid;
    const kill = (signal) => {
      try {
        process.kill(killTarget, signal);
      } catch {
        try {
          child.kill(signal);
        } catch {
          // Process may already have exited.
        }
      }
    };

    kill("SIGTERM");
    await new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(graceTimer);
        child.off("exit", finish);
        resolve();
      };
      const graceTimer = setTimeout(() => {
        kill("SIGKILL");
        finish();
      }, ADAPTER_SHUTDOWN_GRACE_MS);
      child.once("exit", finish);
    });
  }

  handleStdout(data) {
    this.buffer += data.toString();
    let idx;
    while ((idx = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 1);
      if (!line.trim()) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch (error) {
        log("non-json adapter stdout:", truncate(line, 1000));
        continue;
      }
      this.handleMessage(message);
    }
  }

  handleMessage(message) {
    if (message.method) {
      this.handleRequestOrNotification(message);
      return;
    }

    if (message.id != null && this.pending.has(message.id)) {
      const pending = this.pending.get(message.id);
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) {
        pending.reject(new Error(JSON.stringify(message.error)));
      } else {
        pending.resolve(message.result);
      }
    }
  }

  handleRequestOrNotification(message) {
    if (message.method === "session/update") {
      this.handleSessionUpdate(message.params?.sessionId, message.params?.update);
    }

    if (message.id != null) {
      if (message.method === "session/request_permission") {
        const session = this.sessions.get(message.params?.sessionId);
        const policy = normalizePermissionPolicy(session?.permissionPolicy);
        const result = choosePermissionOption(message, policy);
        this.respond(message.id, result);
      } else {
        this.respond(message.id, null);
      }
    }
  }

  handleSessionUpdate(sessionId, update) {
    if (!sessionId || !update) return;
    const session = this.sessions.get(sessionId);
    if (session && update.sessionUpdate === "usage_update") {
      session.latestUsage = {
        used: update.used,
        size: update.size,
        cost: update.cost,
      };
    }

    const collector = this.activeCollectors.get(sessionId);
    if (!collector) return;

    if (update.sessionUpdate === "usage_update") {
      collector.latestUsage = {
        used: update.used,
        size: update.size,
        cost: update.cost,
      };
      collector.maybeReportProgress("usage_update");
      return;
    }

    if (update.sessionUpdate === "agent_message_chunk") {
      const text = update.content?.text;
      if (text) {
        collector.answerParts.push(text);
        collector.charCount += text.length;
        collector.maybeReportProgress("streaming");
      }
      return;
    }

    if (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") {
      const id = update.toolCallId || randomUUID();
      const existing = collector.tools.get(id) || { id };
      collector.tools.set(id, {
        ...existing,
        id,
        title: update.title || existing.title,
        kind: update.kind || existing.kind,
        status: update.status || existing.status,
        rawInput: update.rawInput || existing.rawInput,
        locations: update.locations || existing.locations,
        rawOutput: update.rawOutput || existing.rawOutput,
        content: update.content || existing.content,
        toolName: update._meta?.claudeCode?.toolName || existing.toolName,
      });
      collector.toolCount = collector.tools.size;
      collector.lastToolTitle = update.title || existing.title || update.kind || update._meta?.claudeCode?.toolName || "tool";
      collector.maybeReportProgress("tool_update", true);
    }
  }

  respond(id, result) {
    const message = { jsonrpc: "2.0", id, result };
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  async send(method, params, timeoutMs = DEFAULT_TIMEOUT_MS, { signal } = {}) {
    if (!this.child || this.child.killed) {
      throw new Error("ACP adapter is not running");
    }
    throwIfAborted(signal);
    const id = this.nextId++;
    const message = { jsonrpc: "2.0", id, method, params };
    return new Promise((resolve, reject) => {
      let settled = false;
      const cleanup = () => {
        clearTimeout(timer);
        if (signal) signal.removeEventListener("abort", onAbort);
      };
      const fail = (error) => {
        if (settled) return;
        settled = true;
        this.pending.delete(id);
        cleanup();
        reject(error);
      };
      const succeed = (result) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(result);
      };
      const onAbort = () => fail(codedError("Request was cancelled", "ASK_CLAUDE_CANCELLED"));
      const timer = setTimeout(() => {
        fail(codedError(`Timeout waiting for ${method}`, "ASK_CLAUDE_TIMEOUT"));
      }, timeoutMs);
      if (signal) signal.addEventListener("abort", onAbort, { once: true });
      this.pending.set(id, { resolve: succeed, reject: fail, timer, method });
      this.child.stdin.write(`${JSON.stringify(message)}\n`);
    });
  }

  async createSession({ cwd, sessionKey, model, effort, mode, permissionPolicy }, { signal } = {}) {
    await this.ensureStarted();
    throwIfAborted(signal);
    const resolvedCwd = absCwd(cwd);
    if (!existsSync(resolvedCwd)) {
      throw new Error(`cwd does not exist: ${resolvedCwd}`);
    }
    const result = await this.send("session/new", {
      cwd: resolvedCwd,
      mcpServers: [],
    }, DEFAULT_TIMEOUT_MS, { signal });

    const session = {
      id: result.sessionId,
      key: sessionKey,
      cwd: resolvedCwd,
      createdAt: new Date().toISOString(),
      configOptions: result.configOptions || [],
      models: result.models,
      modes: result.modes,
      latestUsage: null,
      permissionPolicy: normalizePermissionPolicy(permissionPolicy),
      warnings: [],
    };
    this.sessions.set(session.id, session);
    if (sessionKey) this.sessionsByKey.set(sessionKey, session.id);

    await this.configureSession(session, { mode, model, effort }, { signal });
    await this.upsertRegistryEntry(session);
    return session;
  }

  async configureSession(session, { model, effort, mode }, { signal } = {}) {
    for (const [configId, value] of [
      ["mode", mode],
      ["model", model],
      ["effort", effort],
    ]) {
      throwIfAborted(signal);
      if (!value) continue;
      const option = session.configOptions.find((item) => item.id === configId);
      if (!option) {
        session.warnings.push(`Config option unavailable for this session/model: ${configId}`);
        continue;
      }
      if (option.options && !option.options.some((item) => item.value === value)) {
        session.warnings.push(`Unsupported ${configId} value: ${value}`);
        continue;
      }
      try {
        const result = await this.send("session/set_config_option", {
          sessionId: session.id,
          configId,
          value,
        }, ACP_CONFIG_TIMEOUT_MS, { signal });
        session.configOptions = result.configOptions || session.configOptions;
      } catch (error) {
        if (shouldRestartAdapter(error)) throw error;
        session.warnings.push(`Failed to set ${configId}=${value}: ${error.message}`);
      }
    }
  }

  async resumeSessionFromRegistry(entry, args = {}, { signal } = {}) {
    await this.ensureStarted();
    throwIfAborted(signal);
    const resolvedCwd = absCwd(args.cwd || entry.cwd);
    const method = this.agentCapabilities?.sessionCapabilities?.resume ? "session/resume" : "session/load";
    const timeoutMs = method === "session/resume" ? ACP_RESUME_TIMEOUT_MS : ACP_LOAD_TIMEOUT_MS;
    let result;
    try {
      result = await this.send(method, {
        sessionId: entry.session_id,
        cwd: resolvedCwd,
        mcpServers: [],
      }, timeoutMs, { signal });
    } catch (firstError) {
      if (method === "session/resume" && this.agentCapabilities?.loadSession) {
        result = await this.send("session/load", {
          sessionId: entry.session_id,
          cwd: resolvedCwd,
          mcpServers: [],
        }, ACP_LOAD_TIMEOUT_MS, { signal });
      } else {
        throw firstError;
      }
    }

    const age = ageInfo(entry.last_active_at);
    const session = {
      id: entry.session_id,
      key: entry.session_key,
      cwd: resolvedCwd,
      createdAt: entry.created_at || new Date().toISOString(),
      title: entry.title,
      configOptions: result?.configOptions || entry.configOptions || [],
      models: result?.models,
      modes: result?.modes,
      latestUsage: entry.latest_usage || null,
      permissionPolicy: normalizePermissionPolicy(args.permission_policy || entry.permission_policy),
      warnings: [],
    };
    if (age.cache_likely_cold) {
      session.warnings.push("This Claude session was inactive for over 1 hour; provider prefix cache is likely cold even though conversation state may resume.");
    }
    this.sessions.set(session.id, session);
    if (session.key) this.sessionsByKey.set(session.key, session.id);
    await this.configureSession(session, args, { signal });
    await this.upsertRegistryEntry(session, { warnings: session.warnings });
    return session;
  }

  async getOrCreateSession(args, { signal } = {}) {
    await this.ensureRegistryLoaded();
    await this.ensureStarted();
    throwIfAborted(signal);
    if (args.session_id) {
      const session = this.sessions.get(args.session_id);
      if (!session) {
        const entry = this.registry.sessions[args.session_id];
        if (entry && args.reuse_policy !== "never") {
          return this.resumeSessionFromRegistry(entry, args, { signal });
        }
        throw new Error(`Unknown Claude session_id: ${args.session_id}`);
      }
      await this.configureSession(session, args, { signal });
      return session;
    }

    const cwd = absCwd(args.cwd);
    const rawKey = args.session_key || "default";
    const sessionKey = `${cwd}::${rawKey}`;
    const existingId = this.sessionsByKey.get(sessionKey);
    if (existingId && this.sessions.has(existingId)) {
      const session = this.sessions.get(existingId);
      session.permissionPolicy = normalizePermissionPolicy(args.permission_policy || session.permissionPolicy);
      await this.configureSession(session, args);
      return session;
    }

    if (args.reuse_policy !== "never") {
      const entry = Object.values(this.registry.sessions)
        .filter((item) => item.session_key === sessionKey && item.cwd === cwd)
        .sort((a, b) => new Date(b.last_active_at || b.created_at).getTime() - new Date(a.last_active_at || a.created_at).getTime())[0];
      if (entry) {
        const age = ageInfo(entry.last_active_at);
        const large = (entry.latest_usage?.used || 0) >= LARGE_CONTEXT_TOKENS;
        if (args.reuse_policy === "always" || !age.cache_likely_cold || large) {
          return this.resumeSessionFromRegistry(entry, args, { signal });
        }
      }
    }

    return this.createSession({
      cwd,
      sessionKey,
      model: args.model,
      effort: args.effort,
      mode: args.mode,
      permissionPolicy: args.permission_policy,
    }, { signal });
  }

  async runPrompt(session, prompt, { timeoutMs = DEFAULT_TIMEOUT_MS, maxAnswerChars = MAX_ANSWER_CHARS, progressReporter = null, signal } = {}) {
    if (this.activeCollectors.has(session.id)) {
      throw new Error(`Claude session already has an active prompt: ${session.id}`);
    }
    throwIfAborted(signal);
    const startedAt = Date.now();
    const collector = {
      answerParts: [],
      tools: new Map(),
      latestUsage: session.latestUsage,
      charCount: 0,
      toolCount: 0,
      lastToolTitle: null,
      lastProgressAt: 0,
      lastProgressChars: 0,
      reportProgress: progressReporter,
      maybeReportProgress: (phase = "running", force = false) => {
        if (!progressReporter) return;
        const now = Date.now();
        const enoughTime = now - collector.lastProgressAt >= PROGRESS_MIN_INTERVAL_MS;
        const enoughChars = collector.charCount - collector.lastProgressChars >= PROGRESS_CHAR_DELTA;
        if (!force && !enoughTime && !enoughChars) return;
        collector.lastProgressAt = now;
        collector.lastProgressChars = collector.charCount;
        progressReporter({
          phase,
          startedAt,
          charCount: collector.charCount,
          toolCount: collector.tools.size,
          toolTitle: collector.lastToolTitle,
          usage: collector.latestUsage,
        }, force);
      },
    };
    this.activeCollectors.set(session.id, collector);
    collector.maybeReportProgress("started", true);
    const heartbeat = progressReporter
      ? setInterval(() => collector.maybeReportProgress("waiting", true), PROGRESS_HEARTBEAT_MS)
      : null;
    let result;
    try {
      result = await this.send("session/prompt", {
        sessionId: session.id,
        prompt: [{ type: "text", text: prompt }],
      }, timeoutMs, { signal });
    } catch (error) {
      if (shouldRestartAdapter(error)) {
        await this.stopAdapter(`prompt interrupted: ${error.message}`);
      }
      throw error;
    } finally {
      if (heartbeat) clearInterval(heartbeat);
      this.activeCollectors.delete(session.id);
    }
    collector.maybeReportProgress("completed", true);

    const answer = truncate(collector.answerParts.join(""), maxAnswerChars);
    const now = new Date().toISOString();
    session.latestUsage = collector.latestUsage || session.latestUsage;
    if (!session.title) session.title = preview(prompt, 80);
    const tools = [...collector.tools.values()].map((tool) => ({
      id: tool.id,
      toolName: tool.toolName,
      title: tool.title,
      kind: tool.kind,
      status: tool.status,
      rawInput: tool.rawInput,
      locations: tool.locations,
      rawOutput: truncate(tool.rawOutput, 1200),
    }));
    await this.upsertRegistryEntry(session, {
      last_active_at: now,
      latest_usage: session.latestUsage,
      title: session.title,
      turn: {
        at: now,
        prompt_preview: preview(prompt, 1600),
        answer_preview: preview(answer, 2000),
        stop_reason: result?.stopReason,
        usage: result?.usage,
        tool_count: tools.length,
      },
    });
    return {
      session,
      answer,
      tools,
      result,
      usage: collector.latestUsage || session.latestUsage,
    };
  }

}

const bridge = new ClaudeAcpBridge();

function formatClaudeResult(prefix, data) {
  const { session, answer, tools, result, usage } = data;
  const usageInfo = usageSummary(usage);
  const lines = [
    prefix,
    "",
    `Claude session: ${session.id}`,
    `Workspace: ${session.cwd}`,
    usageInfo.text,
  ];
  if (usageInfo.warning) lines.push(`Warning: ${usageInfo.warning}`);
  if (session.warnings.length) {
    lines.push("", "Session warnings:");
    for (const warning of session.warnings.splice(0)) lines.push(`- ${warning}`);
  }
  if (tools.length) {
    lines.push("", "Tool activity:");
    for (const tool of tools) {
      const loc = tool.locations?.length
        ? ` ${tool.locations.map((item) => item.path || "").filter(Boolean).join(", ")}`
        : "";
      lines.push(`- ${tool.status || "unknown"} ${tool.toolName || tool.kind || "tool"}: ${tool.title || tool.id}${loc}`);
      if (tool.rawOutput) lines.push(`  output: ${truncate(tool.rawOutput, 500).replace(/\n/g, "\\n")}`);
    }
  }
  lines.push("", "Claude says:", answer || "(no text response)");
  if (result?.usage) {
    lines.push("", `Turn usage: ${JSON.stringify(result.usage)}`);
  }
  return {
    text: lines.join("\n"),
    structured: {
      session_id: session.id,
      cwd: session.cwd,
      answer,
      tools,
      stop_reason: result?.stopReason,
      usage: usageInfo.usage,
      turn_usage: result?.usage,
    },
  };
}

const server = new McpServer({
  name: "ask-claude",
  version: "0.1.0",
}, {
  capabilities: {
    logging: {},
  },
});

const modelSchema = z.enum(MODEL_VALUES).optional();
const effortSchema = z.enum(EFFORT_VALUES).optional();
const modeSchema = z.enum(MODE_VALUES).optional();
const permissionPolicySchema = z.enum(PERMISSION_POLICY_VALUES).optional();

const commonSessionShape = {
  cwd: z.string().optional().describe("Absolute workspace path. Defaults to ASK_CLAUDE_DEFAULT_CWD or the MCP server process cwd."),
  session_id: z.string().optional().describe("Existing Claude ACP session id to continue."),
  session_key: z.string().optional().describe("Stable key for reusing a Claude session within the cwd. Defaults to 'default'."),
  model: modelSchema.describe("Claude model config if available for this adapter session. Defaults to ASK_CLAUDE_DEFAULT_MODEL when set."),
  effort: effortSchema.describe("Claude reasoning/thought effort if available for the selected model. Defaults to ASK_CLAUDE_DEFAULT_EFFORT when set."),
  mode: modeSchema.describe("Claude Code permission mode if available. Defaults to ASK_CLAUDE_DEFAULT_MODE when set."),
  permission_policy: permissionPolicySchema.describe("MCP-side policy for ACP permission requests. Defaults to ASK_CLAUDE_DEFAULT_PERMISSION_POLICY or readonly."),
  reuse_policy: z.enum(["auto", "always", "never"]).optional().describe("How to handle an inactive matching session_key. auto resumes if recent or large; always resumes; never starts fresh."),
  timeout_ms: z.number().int().positive().optional().describe("Prompt timeout in milliseconds."),
};

function withSessionDefaults(args) {
  return {
    ...args,
    model: args.model ?? DEFAULT_MODEL,
    effort: args.effort ?? DEFAULT_EFFORT,
    mode: args.mode ?? DEFAULT_MODE,
    permission_policy: args.permission_policy ?? DEFAULT_PERMISSION_POLICY,
  };
}

server.registerTool("ask_claude", {
  title: "Ask Claude",
  description: "Ask or continue a multi-turn Claude Code ACP session. Use this for discussion, code review, bug hunting, and follow-up disagreement resolution. Reuse session_id or session_key to preserve Claude context and prefix cache.",
  inputSchema: {
    ...commonSessionShape,
    prompt: z.string().min(1).describe("Message to send to Claude. Include the current problem and relevant code context."),
    max_answer_chars: z.number().int().positive().optional(),
  },
}, async (args, extra) => {
  const sessionArgs = withSessionDefaults(args);
  try {
    const session = await bridge.getOrCreateSession(sessionArgs, { signal: extra.signal });
    session.permissionPolicy = normalizePermissionPolicy(sessionArgs.permission_policy || session.permissionPolicy);
    const result = await bridge.runPrompt(session, sessionArgs.prompt, {
      timeoutMs: sessionArgs.timeout_ms || DEFAULT_TIMEOUT_MS,
      maxAnswerChars: sessionArgs.max_answer_chars || MAX_ANSWER_CHARS,
      progressReporter: makeProgressReporter(extra, "Claude ask"),
      signal: extra.signal,
    });
    const formatted = formatClaudeResult("Claude discussion result", result);
    return asTextResult(formatted.text, formatted.structured);
  } catch (error) {
    if (shouldRestartAdapter(error)) {
      await bridge.stopAdapter(`request interrupted: ${error.message}`);
    }
    throw error;
  }
});

server.registerTool("ask_claude_sessions", {
  title: "List Claude Sessions",
  description: "List active and remembered Claude ACP sessions, including last-active time, context/cost status, and cache-cold recommendations.",
  inputSchema: {
    cwd: z.string().optional().describe("Optional cwd filter."),
    include_inactive: z.boolean().optional().describe("Include remembered sessions not active in this MCP process. Defaults to true."),
  },
}, async (args) => {
  await bridge.ensureRegistryLoaded();
  const cwdFilter = args.cwd ? absCwd(args.cwd) : null;
  const includeInactive = args.include_inactive !== false;
  const fromRegistry = Object.values(bridge.registry.sessions)
    .filter((entry) => includeInactive || bridge.sessions.has(entry.session_id))
    .filter((entry) => !cwdFilter || entry.cwd === cwdFilter)
    .map((entry) => {
      const active = bridge.sessions.has(entry.session_id);
      const age = ageInfo(entry.last_active_at);
      const usage = usageSummary(entry.latest_usage).usage;
      const large = (entry.latest_usage?.used || 0) >= LARGE_CONTEXT_TOKENS;
      let recommendation = "reuse_ok";
      if (!active && age.cache_likely_cold && large) {
        recommendation = "ask_before_resuming_large_cold_session";
      } else if (!active && age.cache_likely_cold) {
        recommendation = "prefer_new_session_unless_history_matters";
      } else if (!active) {
        recommendation = "resume_likely_worthwhile";
      }
      return {
        session_id: entry.session_id,
        session_key: entry.session_key,
        title: entry.title,
        cwd: entry.cwd,
        active,
        created_at: entry.created_at,
        last_active_at: entry.last_active_at,
        age_minutes: age.age_minutes,
        cache_likely_cold: age.cache_likely_cold,
        large_context: large,
        recommendation,
        permission_policy: entry.permission_policy,
        usage,
        recent_turns: (entry.turns || []).slice(-5),
      };
    })
    .sort((a, b) => new Date(b.last_active_at || b.created_at).getTime() - new Date(a.last_active_at || a.created_at).getTime());
  const sessions = fromRegistry;
  return asTextResult(JSON.stringify({ sessions }, null, 2), { sessions });
});

let shuttingDown = false;

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  await bridge.stopAdapter(`server ${signal}`);
  process.exit(0);
}

async function main() {
  refreshTimeoutConfig();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  log("fatal:", error?.stack || error?.message || String(error));
  process.exit(1);
});

process.on("SIGINT", () => {
  shutdown("SIGINT").catch(() => process.exit(1));
});
process.on("SIGTERM", () => {
  shutdown("SIGTERM").catch(() => process.exit(1));
});

export { ClaudeAcpBridge };
