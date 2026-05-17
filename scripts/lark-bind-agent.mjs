#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const DEFAULT_WORKSPACE_ROOT = path.join(os.homedir(), ".openclaw");
const DEFAULT_CONFIG_PATH = path.join(DEFAULT_WORKSPACE_ROOT, "openclaw.json");
const DEFAULT_ACCOUNT_ID = "main";
const FEISHU_BIND_TOOL = "feishu_agent_bind";

function usage(exitCode = 0) {
  const out = exitCode === 0 ? console.log : console.error;
  out(`Usage:
  node scripts/lark-bind-agent.mjs prepare [--config <path>]
  node scripts/lark-bind-agent.mjs save-qr --stdin [--out <path>]
  node scripts/lark-bind-agent.mjs config --dry-run|--commit --agent-id <id> --name <name> --peer-kind direct|group --peer-id <id> [options]

Options:
  --config <path>            OpenClaw config path. Default: ${DEFAULT_CONFIG_PATH} (or OPENCLAW_CONFIG_PATH)
  --account-id <id>          Feishu account id for the binding. Default: ${DEFAULT_ACCOUNT_ID}
  --workspace <path>         New agent workspace. Default: ~/.openclaw/workspace-<agentId>
  --agent-dir <path>         New agent dir. Default: ~/.openclaw/agents/<agentId>/agent
  --dedicated-account        Also create channels.feishu.accounts.<accountId>
  --app-id <cli_xxx>         Dedicated Feishu app id
  --app-secret-env <NAME>    Env var containing the dedicated app secret
  --domain <feishu|lark>     Dedicated account domain. Default: feishu
`);
  process.exit(exitCode);
}

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) {
      args._.push(token);
      continue;
    }
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      args[key] = true;
      continue;
    }
    args[key] = next;
    i += 1;
  }
  return args;
}

function asString(value, name) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Missing required option: --${name}`);
  }
  return value.trim();
}

function optionalString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readStdin() {
  return new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      data += chunk;
    });
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", reject);
  });
}

function loadConfig(configPath) {
  const text = fs.readFileSync(configPath, "utf8");
  return JSON.parse(text);
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function sanitizeAgentId(input) {
  const id = input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!/^[a-z][a-z0-9_-]{1,63}$/.test(id)) {
    throw new Error(
      `Invalid agent id "${input}". Use 2-64 chars, start with a letter, then lowercase letters, digits, "_" or "-".`,
    );
  }
  return id;
}

function normalizePeerKind(value) {
  if (value === "direct" || value === "user" || value === "dm") {
    return "direct";
  }
  if (value === "group" || value === "chat") {
    return "group";
  }
  throw new Error('Invalid --peer-kind. Use "direct" or "group".');
}

function validatePeerId(kind, peerId) {
  if (kind === "direct" && !peerId.startsWith("ou_")) {
    throw new Error('Direct Feishu bindings should use an open_id that starts with "ou_".');
  }
  if (kind === "group" && !peerId.startsWith("oc_")) {
    throw new Error('Group Feishu bindings should use a chat_id that starts with "oc_".');
  }
}

function redactSecretRef(value) {
  if (typeof value !== "string") {
    return value === undefined ? undefined : "<non-string>";
  }
  if (value.startsWith("${") && value.endsWith("}")) {
    return value;
  }
  return "<redacted>";
}

function getConfigPath(args) {
  return optionalString(args.config) ?? process.env.OPENCLAW_CONFIG_PATH ?? DEFAULT_CONFIG_PATH;
}

function listToolsForAgent(cfg, agentId) {
  const agent = (cfg.agents?.list ?? []).find((entry) => entry?.id === agentId);
  const globalAlsoAllow = Array.isArray(cfg.tools?.alsoAllow) ? cfg.tools.alsoAllow : [];
  const agentAlsoAllow = Array.isArray(agent?.tools?.alsoAllow) ? agent.tools.alsoAllow : [];
  return [...new Set([...globalAlsoAllow, ...agentAlsoAllow].filter((item) => typeof item === "string"))];
}

function commandPrepare(args) {
  const configPath = getConfigPath(args);
  const cfg = loadConfig(configPath);
  const defaultAgent =
    (cfg.agents?.list ?? []).find((agent) => agent?.default === true)?.id ??
    cfg.agents?.list?.[0]?.id ??
    "main";
  const tools = listToolsForAgent(cfg, defaultAgent);
  const feishuCfg = cfg.channels?.feishu;
  const defaultAccountId = feishuCfg?.defaultAccount ?? DEFAULT_ACCOUNT_ID;
  const account = feishuCfg?.accounts?.[defaultAccountId] ?? feishuCfg;
  const pluginEnabled =
    cfg.plugins?.entries?.["openclaw-lark"]?.enabled === true ||
    cfg.plugins?.entries?.feishu?.enabled === true;

  printJson({
    ok: true,
    configPath,
    defaultAgent,
    feishu: {
      enabled: feishuCfg?.enabled !== false && Boolean(feishuCfg),
      defaultAccountId,
      accountConfigured: Boolean(account?.appId && account?.appSecret),
      appId: account?.appId ?? feishuCfg?.appId,
      appSecret: redactSecretRef(account?.appSecret ?? feishuCfg?.appSecret),
      domain: account?.domain ?? feishuCfg?.domain ?? "feishu",
    },
    plugin: {
      openclawLarkOrFeishuEnabled: pluginEnabled,
    },
    tools: {
      hasFeishuAgentBind: tools.includes(FEISHU_BIND_TOOL),
      hasFeishuMessageTool:
        tools.includes("message") ||
        tools.includes("feishu_im_user_message") ||
        tools.includes("feishu_im_bot_image"),
      alsoAllow: tools.filter((name) => name.startsWith("feishu_") || name === "message"),
    },
    nextStep: tools.includes(FEISHU_BIND_TOOL)
      ? "Use the feishu_agent_bind tool to begin QR binding."
      : "feishu_agent_bind is not in the current agent allowlist; enable it or use the plugin's documented binding command.",
  });
}

function inferImageExtension(mime) {
  const lower = mime.toLowerCase();
  if (lower.includes("jpeg") || lower.includes("jpg")) {
    return ".jpg";
  }
  if (lower.includes("webp")) {
    return ".webp";
  }
  if (lower.includes("gif")) {
    return ".gif";
  }
  return ".png";
}

async function commandSaveQr(args) {
  const input = args.stdin ? await readStdin() : optionalString(args.input);
  if (!input?.trim()) {
    throw new Error("Provide QR content via --stdin or --input.");
  }
  const raw = input.trim();
  const outArg = optionalString(args.out);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-lark-bind-"));

  let qrPath;
  let sourceKind;
  const dataUrlMatch = raw.match(/^data:(image\/[a-z0-9.+-]+);base64,([a-z0-9+/=\s]+)$/i);
  if (dataUrlMatch) {
    const ext = inferImageExtension(dataUrlMatch[1]);
    qrPath = outArg ?? path.join(tmpDir, `binding-qr${ext}`);
    fs.writeFileSync(qrPath, Buffer.from(dataUrlMatch[2].replace(/\s+/g, ""), "base64"));
    sourceKind = "data-url";
  } else if (/^https?:\/\//i.test(raw)) {
    const encoded = encodeURIComponent(raw);
    const url = `https://api.qrserver.com/v1/create-qr-code/?size=512x512&data=${encoded}`;
    if (args["allow-remote-qr-service"] !== true) {
      qrPath = outArg ?? path.join(tmpDir, "binding-qr-url.txt");
      fs.writeFileSync(qrPath, `${raw}\n`, "utf8");
      sourceKind = "qr-url-text";
      printJson({
        ok: true,
        qrPath,
        sourceKind,
        warning:
          "Input was a URL. The script saved it as text to avoid calling a third-party QR service. Re-run with --allow-remote-qr-service to generate a PNG.",
        qrUrl: raw,
      });
      return;
    }
    qrPath = outArg ?? path.join(tmpDir, "binding-qr.png");
    const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!response.ok) {
      throw new Error(`Remote QR generation failed: HTTP ${response.status}`);
    }
    fs.writeFileSync(qrPath, Buffer.from(await response.arrayBuffer()));
    sourceKind = "remote-qr-service";
  } else if (fs.existsSync(raw)) {
    qrPath = raw;
    sourceKind = "existing-file";
  } else {
    throw new Error("QR input is not a data URL, URL, or existing file path.");
  }

  printJson({ ok: true, qrPath, sourceKind });
}

function defaultWorkspace(agentId) {
  return path.join(DEFAULT_WORKSPACE_ROOT, `workspace-${agentId}`);
}

function defaultAgentDir(agentId) {
  return path.join(DEFAULT_WORKSPACE_ROOT, "agents", agentId, "agent");
}

function buildConfigPatch(cfg, args) {
  const agentId = sanitizeAgentId(asString(args["agent-id"], "agent-id"));
  const name = asString(args.name, "name");
  const peerKind = normalizePeerKind(asString(args["peer-kind"], "peer-kind"));
  const peerId = asString(args["peer-id"], "peer-id");
  validatePeerId(peerKind, peerId);

  const accountId = optionalString(args["account-id"]) ?? DEFAULT_ACCOUNT_ID;
  const workspace = optionalString(args.workspace) ?? defaultWorkspace(agentId);
  const agentDir = optionalString(args["agent-dir"]) ?? defaultAgentDir(agentId);
  const existingAgents = Array.isArray(cfg.agents?.list) ? cfg.agents.list : [];
  const existingBindings = Array.isArray(cfg.bindings) ? cfg.bindings : [];
  const agentExists = existingAgents.some((agent) => agent?.id === agentId);
  const bindingExists = existingBindings.some(
    (binding) =>
      binding?.agentId === agentId &&
      binding?.match?.channel === "feishu" &&
      binding?.match?.accountId === accountId &&
      binding?.match?.peer?.kind === peerKind &&
      binding?.match?.peer?.id === peerId,
  );

  const newAgent = {
    id: agentId,
    name,
    identity: { name },
    workspace,
    agentDir,
    ...(cfg.agents?.defaults?.model ? { model: cfg.agents.defaults.model } : {}),
  };
  const newBinding = {
    agentId,
    match: {
      channel: "feishu",
      accountId,
      peer: { kind: peerKind, id: peerId },
    },
  };

  const nextCfg = {
    ...cfg,
    agents: {
      ...cfg.agents,
      list: agentExists ? existingAgents : [...existingAgents, newAgent],
    },
    bindings: bindingExists ? existingBindings : [...existingBindings, newBinding],
  };

  let dedicatedAccountCreated = false;
  if (args["dedicated-account"] === true) {
    const appId = asString(args["app-id"], "app-id");
    const appSecretEnv = asString(args["app-secret-env"], "app-secret-env");
    if (!/^[A-Z_][A-Z0-9_]*$/.test(appSecretEnv)) {
      throw new Error("--app-secret-env must be an uppercase environment variable name.");
    }
    const domain = optionalString(args.domain) ?? "feishu";
    if (domain !== "feishu" && domain !== "lark") {
      throw new Error('--domain must be "feishu" or "lark".');
    }
    const feishuCfg = nextCfg.channels?.feishu ?? {};
    const accounts = { ...(feishuCfg.accounts ?? {}) };
    dedicatedAccountCreated = !accounts[accountId];
    accounts[accountId] = {
      ...(accounts[accountId] ?? {}),
      enabled: true,
      name,
      appId,
      appSecret: `\${${appSecretEnv}}`,
      domain,
      dmPolicy: "allowlist",
      allowFrom: peerKind === "direct" ? [peerId] : [],
      groupPolicy: peerKind === "group" ? "allowlist" : "disabled",
      groupAllowFrom: peerKind === "group" ? [peerId] : [],
    };
    nextCfg.channels = {
      ...nextCfg.channels,
      feishu: {
        ...feishuCfg,
        enabled: feishuCfg.enabled !== false,
        defaultAccount: feishuCfg.defaultAccount ?? DEFAULT_ACCOUNT_ID,
        accounts,
      },
    };
  }

  return {
    nextCfg,
    summary: {
      agentId,
      name,
      workspace,
      agentDir,
      accountId,
      peer: { kind: peerKind, id: peerId },
      agentCreated: !agentExists,
      agentExists,
      bindingCreated: !bindingExists,
      bindingExists,
      dedicatedAccountCreated,
      dedicatedAccountRequested: args["dedicated-account"] === true,
    },
  };
}

function commandConfig(args) {
  const dryRun = args["dry-run"] === true;
  const commit = args.commit === true;
  if (dryRun === commit) {
    throw new Error("Pass exactly one of --dry-run or --commit.");
  }
  const configPath = getConfigPath(args);
  const cfg = loadConfig(configPath);
  const { nextCfg, summary } = buildConfigPatch(cfg, args);
  if (dryRun) {
    printJson({
      ok: true,
      mode: "dry-run",
      configPath,
      summary,
      nextStep: "Show this summary to the user. Run the same command with --commit only after explicit confirmation.",
    });
    return;
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = `${configPath}.bak-${timestamp}`;
  fs.copyFileSync(configPath, backupPath);
  fs.mkdirSync(summary.workspace, { recursive: true });
  fs.mkdirSync(summary.agentDir, { recursive: true });
  writeJson(configPath, nextCfg);
  printJson({
    ok: true,
    mode: "commit",
    configPath,
    backupPath,
    summary,
    nextStep: "Restart or refresh the OpenClaw gateway if the new Feishu route is not active immediately.",
  });
}

function printJson(value) {
  console.log(JSON.stringify(value, null, 2));
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  if (!command || command === "help" || command === "--help") {
    usage(0);
  }
  const args = parseArgs(rest);
  if (command === "prepare") {
    commandPrepare(args);
    return;
  }
  if (command === "save-qr") {
    await commandSaveQr(args);
    return;
  }
  if (command === "config") {
    commandConfig(args);
    return;
  }
  usage(1);
}

main().catch((error) => {
  console.error(
    JSON.stringify(
      {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      },
      null,
      2,
    ),
  );
  process.exit(1);
});
