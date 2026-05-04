# ChatGPT OAuth Login

Instead of using an OpenAI API key, you can log in with your ChatGPT account via OAuth. This uses OpenAI's Codex backend at `chatgpt.com`.

## Login Methods

Fermi supports two OAuth login methods:

### Browser Login (PKCE) -- Recommended

Opens your default browser for one-click authentication. Best for local development.

```bash
fermi oauth
```

The flow:
1. A local callback server starts on `http://localhost:1455`.
2. Your browser opens the OpenAI authorization page.
3. Log in with your ChatGPT account and authorize Fermi.
4. The browser redirects back to the local server to complete the flow.

### Device Code -- Fallback

For SSH or headless environments where a browser is not available.

```bash
fermi oauth
# Select "Device Code" when prompted
```

The flow:
1. Fermi displays a URL and a code.
2. Open the URL on any device and enter the code.
3. Log in with your ChatGPT account.
4. Fermi polls for completion and stores the token.

## Token Storage

OAuth tokens are saved to `~/.fermi/auth.json`. Access tokens are refreshed automatically when they expire (with a 2-minute early-refresh window).

## Managing OAuth

```bash
# Check login status
fermi oauth status

# Log out (removes stored tokens)
fermi oauth logout
```

## Using OAuth with the Init Wizard

When you run `fermi init`, one of the provider options is **OpenAI (ChatGPT Login)**. Selecting it triggers the OAuth login flow. Fermi then stores an internal OAuth marker for that provider and resolves the actual access token from `~/.fermi/auth.json`, so no API-key env var is needed. If the provider is already configured, you can switch back to it later with `/model`.

Once authenticated, the following models become available:

- GPT-5.2 Codex
- GPT-5.3 Codex
- GPT-5.4
- GPT-5.4 Mini
- GPT-5.5 (context capped at 400K vs 1M on the standard API)

## Limitations

The ChatGPT OAuth backend has some differences from the standard OpenAI API:

- Requests are sent with `store: false` (conversations are not stored on OpenAI's side).
- Native web search is not available through this endpoint.
- Availability depends on your ChatGPT subscription plan.
