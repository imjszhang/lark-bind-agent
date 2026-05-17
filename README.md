# lark-bind-agent

OpenClaw **[Agent Skills](https://agentskills.io)-compatible** skill: create a dedicated agent and bind it to **Feishu/Lark** using the `openclaw-lark` QR binding flow (`feishu_agent_bind`), then patch `openclaw.json` with dry-run and backup.

## Requirements

- OpenClaw with Feishu channel and `openclaw-lark` (or official Feishu plugin) enabled.
- Default OpenClaw config at `~/.openclaw/openclaw.json`, or set `OPENCLAW_CONFIG_PATH`.
- For a custom state directory (for example a non-default profile path), set `OPENCLAW_STATE_DIR`. New agent workspace defaults are created under that directory unless you pass `--workspace` / `--agent-dir`.
- Node.js 18+ (for built-in `fetch` in `save-qr` remote mode).

## Install

Clone or copy this folder into your **active agent workspace** skills directory:

```text
<workspace>/skills/lark-bind-agent/
  SKILL.md
  scripts/lark-bind-agent.mjs
```

Example:

```bash
git clone https://github.com/imjszhang/lark-bind-agent.git \
  "$HOME/.openclaw/workspace/skills/lark-bind-agent"
```

Adjust the destination if your workspace path differs.

Ensure the agent that runs this skill has `feishu_agent_bind` and Feishu messaging tools allowed. Then invoke via [skills](https://docs.openclaw.ai/tools/skills) or `/skill lark-bind-agent`.

## Helper commands

From the skill root, `{baseDir}` is expanded by OpenClaw when the skill runs; on the shell use the real path:

```bash
node scripts/lark-bind-agent.mjs prepare
node scripts/lark-bind-agent.mjs config --dry-run --agent-id my-agent --name "My Agent" \
  --peer-kind direct --peer-id ou_xxxx
# After explicit user confirmation only:
node scripts/lark-bind-agent.mjs config --commit ...
```

## Security

- Never commit real App Secrets or tokens.
- `config --commit` backs up the config file before writing; review `prepare` and `--dry-run` output first.

## License

MIT
