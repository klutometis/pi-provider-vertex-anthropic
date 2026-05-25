# @klutometis/pi-provider-vertex-anthropic

[![npm version](https://img.shields.io/npm/v/@klutometis/pi-provider-vertex-anthropic.svg)](https://npmjs.com/package/@klutometis/pi-provider-vertex-anthropic)
[![license](https://img.shields.io/npm/l/@klutometis/pi-provider-vertex-anthropic.svg)](LICENSE)

Fork of [`pi-provider-vertex-anthropic`](https://github.com/danielcherubini/pi-provider-vertex-anthropic).

## Why this fork exists

This scoped package carries local Vertex/Claude fixes while the upstream pull request is pending. In particular, Claude Opus 4.7 on Vertex requires adaptive thinking:

- `thinking.type = "adaptive"`
- `output_config.effort = "low" | "medium" | "high" | "max"`

rather than the older `thinking.type = "enabled"` payload shape. The fork also registers Claude 4.7 / 4.6-family model metadata and opts 1M-context models into the Anthropic `context-1m-2025-08-07` beta header.

This package is intended as a pinned bootstrap dependency for my Pi installs until equivalent support lands upstream.


A [Pi](https://github.com/nichochar/pi) provider plugin that gives you access to Claude models through **Google Cloud Vertex AI**. Use your existing GCP billing, stay within your organisation's cloud perimeter, and take advantage of regional deployments -- all from inside Pi.

## Features

- **Claude models** from Opus 4.7 down to Haiku 3, including extended/adaptive thinking
- **Streaming** via Vertex AI's `streamRawPredict` endpoint with full SSE support
- **Prompt caching** with automatic ephemeral cache control
- **Multiple auth strategies** -- service account, Application Default Credentials, or the `gcloud` CLI
- **Interactive `/login`** wizard that walks you through project, region, and API setup
- **Cross-tool env vars** -- uses the same variables as Claude Code, with Opencode fallbacks

## Prerequisites

- A Google Cloud project with the [Vertex AI API](https://console.cloud.google.com/apis/library/aiplatform.googleapis.com) enabled
- One of the following authentication methods:
  - [Google Cloud CLI](https://cloud.google.com/sdk/docs/install) (`gcloud`) installed and authenticated
  - A service account key (via `GOOGLE_APPLICATION_CREDENTIALS`)
  - Application Default Credentials (`gcloud auth application-default login`)

## Installation

Install using the Pi extension manager:

```bash
pi install npm:@klutometis/pi-provider-vertex-anthropic
```

The provider registers automatically and will be available the next time you start Pi.

## Configuration

### Interactive setup

Run `/login` inside Pi to walk through authentication, project selection, region selection, and API enablement in one step. Credentials are persisted to `~/.pi/agent/auth.json`.

### Environment variables

You can also configure the provider entirely through environment variables. The plugin checks them in the order shown below, picking the first one it finds.

**Project ID**

| Priority | Variable | Used by |
|----------|----------|---------|
| 1 | `ANTHROPIC_VERTEX_PROJECT_ID` | Claude Code |
| 2 | `GOOGLE_CLOUD_PROJECT` | Opencode, standard GCP tooling |
| 3 | *(persisted from `/login`)* | |

**Region**

| Priority | Variable | Used by |
|----------|----------|---------|
| 1 | `CLOUD_ML_REGION` | Claude Code |
| 2 | `VERTEX_LOCATION` | Opencode |
| 3 | `VERTEXAI_LOCATION` | Opencode (alternative) |
| 4 | *(persisted from `/login`)* | |
| 5 | `us-east5` *(default)* | |

**Authentication**

| Priority | Method | Details |
|----------|--------|---------|
| 1 | Service account | Set `GOOGLE_APPLICATION_CREDENTIALS` to your key file path |
| 2 | Application Default Credentials | Run `gcloud auth application-default login` |
| 3 | Google Cloud CLI | Run `gcloud auth login` |

> [!TIP]
> For local development, `gcloud auth login` is the easiest way to get started.
> For CI or headless environments, use a service account key via `GOOGLE_APPLICATION_CREDENTIALS`.

### Pi settings

To set a Vertex model as your default, add to `~/.pi/agent/settings.json`:

```json
{
  "packages": ["npm:@klutometis/pi-provider-vertex-anthropic"],
  "defaultProvider": "vertex-anthropic",
  "defaultModel": "claude-sonnet-4-5@20250929",
  "enabledModels": [
    "vertex-anthropic/claude-opus-4-6",
    "vertex-anthropic/claude-sonnet-4-5@20250929",
    "vertex-anthropic/claude-haiku-4-5@20251001"
  ]
}
```

## Available models

| Model | ID | Thinking | Max output |
|-------|----|----------|------------|
| Claude Opus 4.6 | `claude-opus-4-6` | Yes | 64k |
| Claude Opus 4.5 | `claude-opus-4-5@20251101` | Yes | 64k |
| Claude Sonnet 4.5 | `claude-sonnet-4-5@20250929` | Yes | 64k |
| Claude Haiku 4.5 | `claude-haiku-4-5@20251001` | Yes | 64k |
| Claude 3.5 Sonnet v2 | `claude-3-5-sonnet-v2@20241022` | No | 8k |
| Claude 3.5 Sonnet | `claude-3-5-sonnet@20240620` | No | 8k |
| Claude 3.5 Haiku | `claude-3-5-haiku@20241022` | No | 8k |
| Claude 3 Opus | `claude-3-opus@20240229` | No | 4k |
| Claude 3 Sonnet | `claude-3-sonnet@20240229` | No | 4k |
| Claude 3 Haiku | `claude-3-haiku@20240307` | No | 4k |

All models support **200k context**, **text + image** input, and **prompt caching**.

## Development

```bash
# Install dependencies
npm install

# Type-check
npm run typecheck

# Run tests
npm run test:run

# Watch mode
npm test
```

## Project structure

```
src/
  index.ts          Extension entry point, provider registration, /login flow
  vertex-api.ts     SSE streaming against Vertex AI's streamRawPredict
  messages.ts       Message transformation and Anthropic API conversion
  auth.ts           Token acquisition (service account, ADC, gcloud CLI)
  config.ts         Environment variable resolution and endpoint building
  models.ts         Model definitions and provider constants
  pre-register.ts   Synchronous model ID collection for pre-registration
  shell.ts          Safe shell execution (spawn with args arrays)
```
