---
name: lark-bind-agent
description: Create an isolated OpenClaw agent, explicitly select or create a Feishu/Lark account, and bind a Feishu/Lark user or chat to that agent. Use when the user asks to create a Feishu/Lark-bound agent, create a dedicated Feishu/Lark bot, bind a new agent by QR code, or route a Feishu/Lark user or chat to a dedicated agent.
---

# Lark Bind Agent

Use this skill to create a dedicated OpenClaw agent, choose or create the Feishu/Lark account for it, and bind a Feishu/Lark user or chat through the `openclaw-lark` plugin's QR binding flow.

## Hard rules

- Do not modify the OpenClaw source checkout.
- Do not write the user's OpenClaw config until they confirm the exact dry-run summary (default path `~/.openclaw/openclaw.json`, or `OPENCLAW_CONFIG_PATH`).
- Never print App Secret, OAuth tokens, or raw credential payloads in chat. Share QR/verification URLs only with the intended user or chat.
- Prefer the existing `feishu_agent_bind` tool for QR binding. The helper script is for preflight, QR file normalization, and safe config patching.
- Never assume `main`. Always use an explicit `accountId` from the user, from `prepare` output, or from a newly created dedicated account.
- Creating a Feishu/Lark app is an external side effect. Run `create-app` only after the user explicitly confirms they want a new bot/app.
- Treat `npx -y @larksuite/openclaw-lark install` and `openclaw channels login --channel feishu` as global setup flows: they may write config and restart the gateway. Do not use them as the default path inside this skill.

## Quick workflow

1. Run preflight:

```bash
node "{baseDir}/scripts/lark-bind-agent.mjs" prepare
```

2. Ask for missing inputs and choose the account path:

- `agentId`: lowercase id for the new agent.
- `displayName`: human-readable name.
- `accountId`: explicit Feishu/Lark account id, or confirmation to create a new dedicated account.
- binding target: current Feishu DM user, explicit `ou_*` user, or explicit `oc_*` group.

3. If using an existing account, start QR binding with the `feishu_agent_bind` tool.

Ask the tool to create a binding QR for the requested target and return a local image path or QR data URL if supported. If the tool returns a data URL or raw QR URL, normalize it:

```bash
node "{baseDir}/scripts/lark-bind-agent.mjs" save-qr --stdin
```

Send the resulting `qrPath` through the Feishu message tool as media. In a Feishu conversation, send it to the current chat unless the user specified another target.

4. Poll or continue the `feishu_agent_bind` flow until it reports success.

Use the plugin's returned `openId`, `chatId`, or `peer` as the binding target. If the result is ambiguous, ask the user before writing config.

5. Dry-run the config patch:

```bash
node "{baseDir}/scripts/lark-bind-agent.mjs" config --dry-run --agent-id <agentId> --name <displayName> --account-id <accountId> --peer-kind direct --peer-id <ou_xxx>
```

For group binding:

```bash
node "{baseDir}/scripts/lark-bind-agent.mjs" config --dry-run --agent-id <agentId> --name <displayName> --account-id <accountId> --peer-kind group --peer-id <oc_xxx>
```

6. Show the dry-run summary to the user and ask for explicit confirmation.

7. Commit only after confirmation:

```bash
node "{baseDir}/scripts/lark-bind-agent.mjs" config --commit --agent-id <agentId> --name <displayName> --account-id <accountId> --peer-kind direct --peer-id <ou_xxx>
```

8. Tell the user to restart or refresh the gateway if routing does not update immediately.

## Dedicated Feishu account

Only use this when the user explicitly wants the new agent to own a separate Feishu app/account. Prefer `accountId=<agentId>` unless the user chooses another id, and show that id in the dry-run summary.

1. Create the Feishu/Lark app only after confirmation:

```bash
node "{baseDir}/scripts/lark-bind-agent.mjs" create-app --confirm-create --secret-mode env --secret-env-var <ENV_NAME>
```

This prints a Feishu/Lark verification URL, then waits for the user to finish registration. On success it writes a credential handoff file that contains `appId`, `domain`, `ownerOpenId`, and a redacted `appSecretRef`; it must not print the App Secret.

For file-backed SecretRef storage:

```bash
node "{baseDir}/scripts/lark-bind-agent.mjs" create-app --confirm-create --secret-mode file --secret-file-path ~/.openclaw/credentials/lark-bind-agent.secrets.json --secret-file-id /<agentId>/appSecret
```

2. Bind the user or group through `feishu_agent_bind`, or use `ownerOpenId` as the direct peer if that is the intended target.

3. Dry-run using the handoff file:

```bash
node "{baseDir}/scripts/lark-bind-agent.mjs" config --dry-run --agent-id <agentId> --name <displayName> --peer-kind direct --peer-id <ou_xxx> --account-id <agentId> --dedicated-account --app-credential-file <handoff.json>
```

Then repeat with `--commit` after confirmation.

Manual secret refs are still supported:

```bash
node "{baseDir}/scripts/lark-bind-agent.mjs" config --dry-run --agent-id <agentId> --name <displayName> --peer-kind direct --peer-id <ou_xxx> --account-id <accountId> --dedicated-account --app-id <cli_xxx> --app-secret-env <ENV_NAME> --domain feishu
```

## Validation

After commit, verify the script output includes:

- `agentCreated` or `agentExists`.
- `bindingCreated` or `bindingExists`.
- `backupPath`.
- `dedicatedAccountSecret` when a dedicated account was created.

Then ask the user to send a Feishu/Lark test message from the bound user or chat. If routing still goes to the old agent, restart the gateway.
