#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const FALLBACK_CONFIG_PATH = path.join(os.homedir(), ".openclaw", "openclaw.json");
const DEFAULT_ACCOUNT_ID = "main";
const FEISHU_BIND_TOOL = "feishu_agent_bind";
const DEFAULT_SECRET_PROVIDER = "lark-bind-agent-secrets";
const DEFAULT_DM_SCOPE = "per-account-channel-peer";

function usage(exitCode = 0) {
  const out = exitCode === 0 ? console.log : console.error;
  out(`Usage:
  node scripts/lark-bind-agent.mjs prepare [--config <path>]
  node scripts/lark-bind-agent.mjs save-qr --stdin [--out <path>]
  node scripts/lark-bind-agent.mjs create-app --confirm-create [options]
  node scripts/lark-bind-agent.mjs config --dry-run|--commit --agent-id <id> --name <name> --peer-kind direct|group --peer-id <id> [options]

Options:
  --config <path>            OpenClaw config path. Default: $OPENCLAW_CONFIG_PATH or ~/.openclaw/openclaw.json
  --account-id <id>          Feishu account id for the binding. Required for existing accounts; defaults to agent id for --dedicated-account.
  --workspace <path>         New agent workspace. Default: ~/.openclaw/workspace-<agentId>
  --agent-dir <path>         New agent dir. Default: ~/.openclaw/agents/<agentId>/agent
  --dedicated-account        Also create channels.feishu.accounts.<accountId>
  --app-id <cli_xxx>         Dedicated Feishu app id
  --app-secret-env <NAME>    Env var containing the dedicated app secret
  --app-secret-ref <json>    SecretRef JSON for the dedicated app secret
  --app-credential-file <path>
                            Handoff JSON produced by create-app
  --domain <feishu|lark>     Dedicated account domain. Default: feishu
  --confirm-create           Required before create-app calls Feishu/Lark registration APIs
  --secret-mode <env|file>   Secret storage mode for create-app. Default: env
  --secret-env-var <NAME>    Env var name for --secret-mode env
  --secret-file-path <path>  Secret file path for --secret-mode file
  --secret-file-id <ptr>     JSON pointer for --secret-mode file. Default: /lark-bind-agent/appSecret
  --credential-out <path>    Handoff file path for create-app output
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

function normalizeDomain(value) {
  const domain = optionalString(value) ?? "feishu";
  if (domain !== "feishu" && domain !== "lark") {
    throw new Error('--domain must be "feishu" or "lark".');
  }
  return domain;
}

function resolveUserPath(input) {
  if (!input) {
    return input;
  }
  if (input === "~") {
    return os.homedir();
  }
  if (input.startsWith("~/") || input.startsWith("~\\")) {
    return path.join(os.homedir(), input.slice(2));
  }
  return path.resolve(input);
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
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
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
  if (value === undefined) {
    return undefined;
  }
  if (typeof value === "object" && value !== null) {
    return describeSecretRef(value);
  }
  if (typeof value !== "string") {
    return "<non-string>";
  }
  if (value.startsWith("${") && value.endsWith("}")) {
    return value;
  }
  return "<redacted>";
}

function isSecretRef(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    typeof value.source === "string" &&
    typeof value.provider === "string" &&
    typeof value.id === "string" &&
    ["env", "file", "exec"].includes(value.source)
  );
}

function describeSecretRef(ref) {
  if (!isSecretRef(ref)) {
    return "<invalid-secret-ref>";
  }
  if (ref.source === "env") {
    return `env:${ref.id}`;
  }
  return `${ref.source}:${ref.provider}:${ref.id}`;
}

function getConfigPath(args) {
  const fromArg = optionalString(args.config);
  if (fromArg) {
    return path.normalize(fromArg);
  }
  const fromEnv = process.env.OPENCLAW_CONFIG_PATH?.trim();
  if (fromEnv) {
    return path.normalize(fromEnv);
  }
  return FALLBACK_CONFIG_PATH;
}

function resolveStateRoot(args) {
  const fromEnv = process.env.OPENCLAW_STATE_DIR?.trim();
  if (fromEnv) {
    return path.normalize(fromEnv);
  }
  return path.dirname(getConfigPath(args));
}

function defaultCredentialOut(args, appId) {
  const safeAppId = String(appId || "app").replace(/[^a-zA-Z0-9_.-]+/g, "-");
  return path.join(resolveStateRoot(args), "credentials", `lark-bind-agent-${safeAppId}.handoff.json`);
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
  const accountIds = listFeishuAccounts(feishuCfg);
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
      accounts: accountIds,
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
      ? "Choose an explicit Feishu accountId or create a new account, then use the feishu_agent_bind tool to begin QR binding."
      : "feishu_agent_bind is not in the current agent allowlist; enable it or use the plugin's documented binding command.",
  });
}

function listFeishuAccounts(feishuCfg) {
  if (!feishuCfg) {
    return [];
  }
  const ids = [];
  const topLevelConfigured = Boolean(feishuCfg.appId && feishuCfg.appSecret);
  if (topLevelConfigured) {
    ids.push({
      accountId: feishuCfg.defaultAccount ?? DEFAULT_ACCOUNT_ID,
      configured: true,
      appId: feishuCfg.appId,
      domain: feishuCfg.domain ?? "feishu",
      source: "top-level",
    });
  }
  for (const [accountId, account] of Object.entries(feishuCfg.accounts ?? {})) {
    ids.push({
      accountId,
      configured: Boolean(account?.appId && account?.appSecret),
      appId: account?.appId,
      domain: account?.domain ?? feishuCfg.domain ?? "feishu",
      source: "accounts",
    });
  }
  return ids;
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

function registrationBase(domain) {
  return domain === "lark" ? "https://accounts.larksuite.com" : "https://accounts.feishu.cn";
}

async function postRegistration(domain, body, timeoutMs = 10_000) {
  const response = await fetch(`${registrationBase(domain)}/oauth/v1/app/registration`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body).toString(),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await response.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`Registration API returned non-JSON response: HTTP ${response.status}`);
  }
  if (!response.ok && data?.error) {
    return data;
  }
  if (!response.ok) {
    const message = data?.error_description || data?.message || text || `HTTP ${response.status}`;
    throw new Error(`Registration API failed: ${message}`);
  }
  return data;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function setByJsonPointer(obj, pointer, value) {
  if (!pointer.startsWith("/")) {
    throw new Error("--secret-file-id must be a JSON pointer that starts with /.");
  }
  const tokens = pointer.split("/").slice(1);
  let current = obj;
  for (let i = 0; i < tokens.length - 1; i += 1) {
    const key = tokens[i].replace(/~1/g, "/").replace(/~0/g, "~");
    if (!current[key] || typeof current[key] !== "object" || Array.isArray(current[key])) {
      current[key] = {};
    }
    current = current[key];
  }
  const lastKey = tokens[tokens.length - 1].replace(/~1/g, "/").replace(/~0/g, "~");
  current[lastKey] = value;
}

function validateEnvName(name) {
  if (!/^[A-Z_][A-Z0-9_]*$/.test(name)) {
    throw new Error("Environment variable names must be uppercase and match /^[A-Z_][A-Z0-9_]*$/.");
  }
}

function appendOrReplaceEnvVar(envFilePath, envName, value) {
  validateEnvName(envName);
  let envContent = "";
  if (fs.existsSync(envFilePath)) {
    envContent = fs.readFileSync(envFilePath, "utf8");
  }
  const lineRegex = new RegExp(`^${envName}=.*$`, "m");
  const nextLine = `${envName}=${value}`;
  const nextContent = lineRegex.test(envContent)
    ? envContent.replace(lineRegex, nextLine)
    : `${envContent.trimEnd()}\n${nextLine}\n`;
  fs.mkdirSync(path.dirname(envFilePath), { recursive: true });
  fs.writeFileSync(envFilePath, nextContent, { encoding: "utf8", mode: 0o600 });
  if (process.platform !== "win32") {
    fs.chmodSync(envFilePath, 0o600);
  }
}

function writeSecretFile(secretFilePath, pointer, value) {
  let existing = {};
  if (fs.existsSync(secretFilePath)) {
    try {
      existing = JSON.parse(fs.readFileSync(secretFilePath, "utf8"));
    } catch {
      existing = {};
    }
  }
  setByJsonPointer(existing, pointer, value);
  fs.mkdirSync(path.dirname(secretFilePath), { recursive: true });
  fs.writeFileSync(secretFilePath, `${JSON.stringify(existing, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  if (process.platform !== "win32") {
    fs.chmodSync(secretFilePath, 0o600);
  }
}

function storeAppSecret(appSecret, args) {
  const mode = optionalString(args["secret-mode"]) ?? "env";
  if (mode === "env") {
    const envName = optionalString(args["secret-env-var"]) ?? "LARK_BIND_AGENT_APP_SECRET";
    const envFilePath = path.join(resolveStateRoot(args), ".env");
    appendOrReplaceEnvVar(envFilePath, envName, appSecret);
    return {
      appSecretRef: { source: "env", provider: "default", id: envName },
      appSecretRefDescription: `env:${envName}`,
      storage: { mode: "env", envFilePath, envName },
    };
  }
  if (mode === "file") {
    const secretFilePath = resolveUserPath(
      optionalString(args["secret-file-path"]) ??
        path.join(resolveStateRoot(args), "credentials", "lark-bind-agent.secrets.json"),
    );
    const pointer = optionalString(args["secret-file-id"]) ?? "/lark-bind-agent/appSecret";
    writeSecretFile(secretFilePath, pointer, appSecret);
    return {
      appSecretRef: { source: "file", provider: DEFAULT_SECRET_PROVIDER, id: pointer },
      appSecretRefDescription: `file:${DEFAULT_SECRET_PROVIDER}:${pointer}`,
      storage: {
        mode: "file",
        secretFilePath,
        provider: DEFAULT_SECRET_PROVIDER,
        providerConfig: { source: "file", path: secretFilePath },
      },
    };
  }
  throw new Error('--secret-mode must be "env" or "file".');
}

async function commandCreateApp(args) {
  if (args["confirm-create"] !== true) {
    throw new Error("create-app creates a Feishu/Lark application. Re-run with --confirm-create after user confirmation.");
  }

  let domain = normalizeDomain(args.domain);
  const initRes = await postRegistration(domain, { action: "init" });
  const supportedMethods = Array.isArray(initRes.supported_auth_methods) ? initRes.supported_auth_methods : [];
  if (!supportedMethods.includes("client_secret")) {
    throw new Error("Current registration environment does not support client_secret auth.");
  }

  const beginRes = await postRegistration(domain, {
    action: "begin",
    archetype: "PersonalAgent",
    auth_method: "client_secret",
    request_user_info: "open_id",
  });

  if (!beginRes.device_code || !beginRes.verification_uri_complete) {
    throw new Error("Registration begin response did not include device_code or verification URI.");
  }

  const startedAt = Date.now();
  const expireSeconds = Number(beginRes.expire_in ?? beginRes.expires_in ?? 600);
  let intervalSeconds = Number(beginRes.interval ?? 5);
  let switchedDomain = false;

  printJson({
    ok: true,
    mode: "create-app-pending",
    domain,
    verificationUriComplete: beginRes.verification_uri_complete,
    userCode: beginRes.user_code,
    expiresIn: expireSeconds,
    nextStep: "Open or scan verificationUriComplete with Feishu/Lark, then keep this command running until it prints create-app-complete.",
  });

  while (Date.now() - startedAt < expireSeconds * 1000) {
    const pollRes = await postRegistration(domain, {
      action: "poll",
      device_code: beginRes.device_code,
    });

    const tenantBrand = pollRes.user_info?.tenant_brand;
    if (!switchedDomain && tenantBrand === "lark" && domain !== "lark") {
      domain = "lark";
      switchedDomain = true;
      continue;
    }

    if (pollRes.client_id && pollRes.client_secret) {
      const stored = storeAppSecret(pollRes.client_secret, args);
      const credentialOut = path.normalize(optionalString(args["credential-out"]) ?? defaultCredentialOut(args, pollRes.client_id));
      const handoff = {
        appId: pollRes.client_id,
        domain,
        ownerOpenId: pollRes.user_info?.open_id,
        appSecretRef: stored.appSecretRef,
        appSecretRefDescription: stored.appSecretRefDescription,
        secretProvider:
          stored.storage.mode === "file"
            ? { name: stored.storage.provider, config: stored.storage.providerConfig }
            : undefined,
        createdAt: new Date().toISOString(),
      };
      writeJson(credentialOut, handoff);
      printJson({
        ok: true,
        mode: "create-app-complete",
        credentialFile: credentialOut,
        appId: pollRes.client_id,
        domain,
        ownerOpenId: pollRes.user_info?.open_id,
        appSecretRef: stored.appSecretRefDescription,
        storage: {
          mode: stored.storage.mode,
          envFilePath: stored.storage.envFilePath,
          secretFilePath: stored.storage.secretFilePath,
        },
        nextStep: "Use --app-credential-file with config --dry-run for the dedicated Feishu account.",
      });
      return;
    }

    if (pollRes.error) {
      if (pollRes.error === "authorization_pending") {
        await sleep(intervalSeconds * 1000);
        continue;
      }
      if (pollRes.error === "slow_down") {
        intervalSeconds += 5;
        await sleep(intervalSeconds * 1000);
        continue;
      }
      if (pollRes.error === "access_denied") {
        throw new Error("User denied Feishu/Lark app registration.");
      }
      if (pollRes.error === "expired_token") {
        throw new Error("Feishu/Lark app registration session expired.");
      }
      throw new Error(`Feishu/Lark app registration failed: ${pollRes.error_description ?? pollRes.error}`);
    }

    await sleep(intervalSeconds * 1000);
  }

  throw new Error("Feishu/Lark app registration timed out.");
}

function defaultWorkspace(agentId, args) {
  return path.join(resolveStateRoot(args), `workspace-${agentId}`);
}

function defaultAgentDir(agentId, args) {
  return path.join(resolveStateRoot(args), "agents", agentId, "agent");
}

function buildConfigPatch(cfg, args) {
  const agentId = sanitizeAgentId(asString(args["agent-id"], "agent-id"));
  const name = asString(args.name, "name");
  const peerKind = normalizePeerKind(asString(args["peer-kind"], "peer-kind"));
  const peerId = asString(args["peer-id"], "peer-id");
  validatePeerId(peerKind, peerId);

  const dedicatedAccountRequested = args["dedicated-account"] === true;
  const accountId = optionalString(args["account-id"]) ?? (dedicatedAccountRequested ? agentId : undefined);
  if (!accountId) {
    throw new Error("--account-id is required when binding an existing Feishu account.");
  }
  const workspace = optionalString(args.workspace) ?? defaultWorkspace(agentId, args);
  const agentDir = optionalString(args["agent-dir"]) ?? defaultAgentDir(agentId, args);
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
  let dedicatedAccountSecret;
  let dmScopeUpdated = false;
  if (dedicatedAccountRequested) {
    const credential = readCredentialInput(args);
    const appId = credential.appId;
    const appSecret = credential.appSecret;
    const domain = credential.domain ?? normalizeDomain(args.domain);
    const feishuCfg = nextCfg.channels?.feishu ?? {};
    const accounts = { ...(feishuCfg.accounts ?? {}) };
    dedicatedAccountCreated = !accounts[accountId];
    accounts[accountId] = {
      ...(accounts[accountId] ?? {}),
      enabled: true,
      name,
      appId,
      appSecret,
      domain,
      dmPolicy: "allowlist",
      allowFrom: peerKind === "direct" ? [peerId] : [],
      groupPolicy: peerKind === "group" ? "allowlist" : "disabled",
      groupAllowFrom: peerKind === "group" ? [peerId] : [],
    };
    const hadFeishuConfig = Boolean(nextCfg.channels?.feishu);
    nextCfg.channels = {
      ...nextCfg.channels,
      feishu: {
        ...feishuCfg,
        enabled: feishuCfg.enabled !== false,
        ...(hadFeishuConfig ? {} : { defaultAccount: accountId }),
        accounts,
      },
    };
    if (credential.secretProvider) {
      nextCfg.secrets = {
        ...nextCfg.secrets,
        providers: {
          ...nextCfg.secrets?.providers,
          [credential.secretProvider.name]: credential.secretProvider.config,
        },
      };
    }
    const accountCount = listFeishuAccounts(nextCfg.channels.feishu).length;
    if (accountCount > 1 && nextCfg.session?.dmScope !== DEFAULT_DM_SCOPE) {
      nextCfg.session = {
        ...nextCfg.session,
        dmScope: DEFAULT_DM_SCOPE,
      };
      dmScopeUpdated = true;
    }
    dedicatedAccountSecret = credential.appSecretDescription;
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
      dedicatedAccountRequested,
      dedicatedAccountSecret,
      dmScopeUpdated,
      dmScope: nextCfg.session?.dmScope,
    },
  };
}

function readCredentialInput(args) {
  const credentialFile = optionalString(args["app-credential-file"]);
  if (credentialFile) {
    const credential = loadConfig(path.normalize(credentialFile));
    const appId = asString(credential.appId, "appId in credential file");
    const domain = normalizeDomain(credential.domain);
    const appSecretRef = credential.appSecretRef;
    if (!isSecretRef(appSecretRef)) {
      throw new Error("--app-credential-file must contain appSecretRef { source, provider, id }.");
    }
    return {
      appId,
      domain,
      appSecret: appSecretRef,
      appSecretDescription: credential.appSecretRefDescription ?? describeSecretRef(appSecretRef),
      secretProvider: credential.secretProvider,
    };
  }

  const appId = asString(args["app-id"], "app-id");
  if (args["app-secret-ref"]) {
    let appSecretRef;
    try {
      appSecretRef = JSON.parse(args["app-secret-ref"]);
    } catch {
      throw new Error("--app-secret-ref must be valid JSON.");
    }
    if (!isSecretRef(appSecretRef)) {
      throw new Error("--app-secret-ref must be a SecretRef object with source, provider, and id.");
    }
    return {
      appId,
      domain: normalizeDomain(args.domain),
      appSecret: appSecretRef,
      appSecretDescription: describeSecretRef(appSecretRef),
    };
  }

  const appSecretEnv = optionalString(args["app-secret-env"]);
  if (appSecretEnv) {
    validateEnvName(appSecretEnv);
    const ref = { source: "env", provider: "default", id: appSecretEnv };
    return {
      appId,
      domain: normalizeDomain(args.domain),
      appSecret: ref,
      appSecretDescription: describeSecretRef(ref),
    };
  }

  throw new Error("Dedicated accounts require --app-credential-file, --app-secret-ref, or --app-secret-env.");
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
  if (command === "create-app") {
    await commandCreateApp(args);
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
