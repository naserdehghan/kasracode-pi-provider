# KasraCode provider for Pi

Adds a `kasracode` provider to [Pi](https://pi.dev). It connects to the OpenAI-compatible endpoint
`https://code.kasracloud.ir/v1` and gets its model list from `GET /v1/models`.

## Install

```bash
pi install git:github.com/naserdehghan/kasracode-pi-provider
```

You can pin a tag or branch with `@<ref>`, for example `git:github.com/naserdehghan/kasracode-pi-provider@v0.1.0`.
Run `pi update --extensions` later to get new versions.

To try it once without installing:

```bash
git clone https://github.com/naserdehghan/kasracode-pi-provider
pi -e ./kasracode-pi-provider/index.ts
```

## Set the API key

Use one of these:

- In Pi, run `/login kasracode`, choose **API key** and paste your key. Pi saves it in `~/.pi/agent/auth.json`.
- Set `export KASRACODE_API_KEY=sk-...` in your shell.

A key saved with `/login` is used before the environment variable.

## Models

- Pi refreshes the list in the background when it starts in interactive mode, when you open `/model`, after `/login`, and when you run `pi update --models`.
- Only chat models are kept. Image and video generation models are skipped.
- The latest list is cached in `~/.pi/agent/kasracode-models.json`, so models still show up offline and in `pi -p`.
- Each catalog field becomes a Pi model setting:
  - `context_length` / `max_input_tokens` → `contextWindow`
  - `max_output_tokens` → `maxTokens` (32,768 if missing)
  - `capabilities.vision` / `input_modalities` → image input
  - `capabilities.reasoning` → `reasoning`
  - `capabilities.effort_tiers` → `thinkingLevelMap`
  - `pricing` → cost per million tokens
- Models whose `supported_endpoints` lists only `responses` use Pi's `openai-responses` API (`/v1/responses`). All other models use `openai-completions` (`/v1/chat/completions`).

Select a model with `/model` or `pi --model kasracode/kasra-team`.

## Environment overrides

| Variable | Default |
|---|---|
| `KASRACODE_API_KEY` | — |
| `KASRACODE_BASE_URL` | `https://code.kasracloud.ir/v1` |
| `KASRACODE_MODELS_CACHE` | `~/.pi/agent/kasracode-models.json` |
