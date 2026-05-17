---
name: lark-bind-agent
description: Create an isolated OpenClaw agent and bind it to Feishu/Lark through the openclaw-lark QR binding flow. Use when the user asks to create a Feishu/Lark-bound agent, bind a new agent by QR code, or route a Feishu/Lark user or chat to a dedicated agent.
---

# Lark Bind Agent

Use this skill to create a dedicated OpenClaw agent and bind a Feishu/Lark user or chat to it through the `openclaw-lark` plugin's QR binding flow.

## Hard rules

- Do not modify the OpenClaw source checkout.
- Do not write the user's OpenClaw config until they confirm the exact dry-run summary (default path `~/.openclaw/openclaw.json`, or `OPENCLAW_CONFIG_PATH`).
- Never print App Secret, OAuth tokens, QR internals, or raw credential payloads in chat.
- Prefer the existing `feishu_agent_bind` tool for QR binding. The helper script is for preflight, QR file normalization, and safe config patching.
- Default to the existing Feishu account `main` unless the user explicitly asks for a new Feishu app/account.

## Quick workflow

1. Run preflight:

```bash
node "{baseDir}/scripts/lark-bind-agent.mjs" prepare
```

2. Ask for missing inputs:

- `agentId`: lowercase id for the new agent.
- `displayName`: human-readable name.
- binding target: current Feishu DM user, explicit `ou_*` user, or explicit `oc_*` group.

3. Start QR binding with the `feishu_agent_bind` tool.

Ask the tool to create a binding QR for the requested target and return a local image path or QR data URL if supported. If the tool returns a data URL or raw QR URL, normalize it:

```bash
node "{baseDir}/scripts/lark-bind-agent.mjs" save-qr --stdin
```

Send the resulting `qrPath` through the Feishu message tool as media. In a Feishu conversation, send it to the current chat unless the user specified another target.

4. Poll or continue the `feishu_agent_bind` flow until it reports success.

Use the plugin's returned `openId`, `chatId`, or `peer` as the binding target. If the result is ambiguous, ask the user before writing config.

5. Dry-run the config patch:

```bash
node "{baseDir}/scripts/lark-bind-agent.mjs" config --dry-run --agent-id <agentId> --name <displayName> --peer-kind direct --peer-id <ou_xxx>
```

For group binding:

```bash
node "{baseDir}/scripts/lark-bind-agent.mjs" config --dry-run --agent-id <agentId> --name <displayName> --peer-kind group --peer-id <oc_xxx>
```

6. Show the dry-run summary to the user and ask for explicit confirmation.

7. Commit only after confirmation:

```bash
node "{baseDir}/scripts/lark-bind-agent.mjs" config --commit --agent-id <agentId> --name <displayName> --peer-kind direct --peer-id <ou_xxx>
```

8. Tell the user to restart or refresh the gateway if routing does not update immediately.

## Dedicated Feishu account

Only use this when the user explicitly wants the new agent to own a separate Feishu app/account.

Do not pass raw secrets on the command line. Store the secret in an environment variable or existing secret provider first, then use:

```bash
node "{baseDir}/scripts/lark-bind-agent.mjs" config --dry-run --agent-id <agentId> --name <displayName> --peer-kind direct --peer-id <ou_xxx> --account-id <agentId> --dedicated-account --app-id <cli_xxx> --app-secret-env <ENV_NAME> --domain feishu
```

Then repeat with `--commit` after confirmation.

## Validation

After commit, verify the script output includes:

- `agentCreated` or `agentExists`.
- `bindingCreated` or `bindingExists`.
- `backupPath`.

Then ask the user to send a Feishu/Lark test message from the bound user or chat. If routing still goes to the old agent, restart the gateway.
