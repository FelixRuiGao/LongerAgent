# Local Providers

Fermi supports three local inference servers: Ollama, oMLX, and LM Studio. These run models on your own hardware with no API key required.

## How Local Providers Work

All local providers use the OpenAI-compatible Chat Completions API. During `fermi init`, the wizard queries the server's `/v1/models` endpoint to discover available models automatically.

The key differences from cloud providers:

- **No API key needed** -- the wizard skips the key prompt
- **Dynamic model discovery** -- models are fetched from the running server at setup time
- **Web search disabled** -- local models do not have native web search support
- **Context length is set manually** -- since local models don't always report their context window, you can specify it during init

## Ollama

[Ollama](https://ollama.com/) runs open-weight models locally.

**Default URL:** `http://localhost:11434/v1`

### Setup

1. Install Ollama and pull at least one model:
   ```bash
   # Install Ollama (macOS)
   brew install ollama

   # Pull a model
   ollama pull llama3.1
   ```

2. Start the Ollama server:
   ```bash
   ollama serve
   ```

3. Run `fermi init` and select **Ollama (Local)**.

4. The wizard will query `http://localhost:11434/v1/models` and show the available models. Pick one.

5. Enter the model's context length when prompted (e.g., 128000 for Llama 3.1).

## oMLX

[oMLX](https://github.com/nicholasgasior/omlx) serves MLX-optimized models for Apple Silicon Macs.

**Default URL:** `http://localhost:8000/v1`

### Setup

1. Install and start oMLX with your preferred MLX model.

2. Run `fermi init` and select **oMLX (Local)**.

3. The wizard discovers models from `http://localhost:8000/v1/models`. Pick one.

4. Enter the model's context length when prompted.

## LM Studio

[LM Studio](https://lmstudio.ai/) provides a desktop app for running GGUF models locally.

**Default URL:** `http://localhost:1234/v1`

### Setup

1. Download and install LM Studio.

2. Load a model in LM Studio and start the local server (under the "Local Server" tab).

3. Run `fermi init` and select **LM Studio (Local)**.

4. The wizard discovers models from `http://localhost:1234/v1/models`. Pick one.

5. Enter the model's context length when prompted.

## Tips for Local Models

- Make sure the server is running **before** you run `fermi init`. The wizard needs to query it for available models.
- If you change models in your local server, re-run `fermi init` to update Fermi's configuration.
- Local models generally have lower context windows than cloud models. Fermi's context management (summarize, compact) becomes especially important for keeping sessions productive.
- Use `/model` at runtime to switch between local and cloud models within the same session.
