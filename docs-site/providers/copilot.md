# GitHub Copilot

Fermi can use your GitHub Copilot subscription as a model provider. Authentication uses the GitHub Device Flow -- the same mechanism used by VS Code's Copilot extension.

## Login

Use the `/copilot` command inside a Fermi session, or run the OAuth command from the CLI:

```bash
fermi oauth login copilot
```

Or inside a session:

```text
/copilot
```

The flow:
1. Fermi displays a URL (`https://github.com/login/device`) and a one-time code.
2. Open the URL in any browser and enter the code.
3. Authorize the application with your GitHub account.
4. Fermi stores the token and Copilot models become available.

## Token Storage

The GitHub token is stored in `~/.fermi/auth.json` under the `github_copilot` field. The token does not expire on its own -- it remains valid until you revoke the application from your GitHub account settings.

## Available Models

Once authenticated, these models appear in the `/model` picker:

| Model | Premium multiplier |
|-------|-------------------|
| Claude Opus 4.6 | 3× |
| Claude Opus 4.6 Fast | 30× |
| Claude Opus 4.7 | 7.5× |
| Claude Sonnet 4.6 | 1× |
| GPT-5.2 | 1× |
| GPT-5.2 Codex | 1× |
| GPT-5.3 Codex | 1× |
| GPT-5.4 | 1× |
| GPT-5.4 Mini | 0.33× |
| GPT-5.5 | 1× |
| GPT-5 Mini | free |

Availability depends on your Copilot subscription plan. Fermi routes requests through GitHub's Copilot API endpoint.

## Checking Status

```bash
fermi oauth status copilot
```

This shows whether Fermi has stored GitHub Copilot credentials.

## Logging Out

```bash
fermi oauth logout copilot
```

This removes the stored token. You can also revoke access from your GitHub account settings under **Settings > Applications > Authorized GitHub Apps**.

## How It Works

Fermi uses the public VS Code Copilot client ID for the GitHub Device Flow. After obtaining a GitHub user token, it exchanges it for a short-lived Copilot API token via GitHub's internal Copilot token endpoint. This API token is automatically refreshed as needed during a session.

Requests are routed through the Copilot API with the same editor-identification headers used by VS Code's Copilot extension.

## Requirements

- An active GitHub Copilot subscription (Individual, Business, or Enterprise).
- A GitHub account with Copilot enabled.

## Limitations

- Only the Device Flow is available for login (no browser-based PKCE flow).
- If GitHub revokes the token (e.g., the user removes the app from their account), Fermi will prompt you to re-authenticate.
