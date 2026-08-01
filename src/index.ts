import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import type { ExtensionAPI } from '@mariozechner/pi-coding-agent'

import { findGoogleCloudCliPath, getGoogleCloudCliToken } from './auth'
import { buildEndpointHost, resolveConfig } from './config'
import { discoverVertexModels } from './model-discovery'
import { API_NAME, PROVIDER_NAME, VERTEX_MODELS, type VertexModel } from './models'
import { streamVertexAnthropic } from './vertex-api'
import { exec, spawn } from './shell'
import { collectPreRegisterModels } from './pre-register'

const SETTINGS_PATH = join(homedir(), '.pi', 'agent', 'settings.json')

const REGION_CHOICES: Record<string, string> = {
  '1': 'global',
  '2': 'us-east5',
  '3': 'us-central1',
  '4': 'europe-west1',
  '5': 'asia-southeast1',
}

function stubModelForId(id: string, catalog: readonly VertexModel[]): VertexModel {
  const known = catalog.find((m) => m.id === id)
  if (known) return known
  const newer = /claude-(?:opus|sonnet|haiku)-(\d+)(?:-(\d+))?/.exec(id)
  const major = newer ? parseInt(newer[1], 10) : 0
  const minor = newer && newer[2] ? parseInt(newer[2], 10) : 0
  const isNewer = major >= 5 || (major === 4 && minor >= 6)
  return {
    id,
    name: id,
    reasoning: isNewer,
    input: ['text', 'image'],
    contextWindow: isNewer ? 1000000 : 200000,
    maxTokens: isNewer ? 64000 : 8192,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  }
}

export default async function(pi: ExtensionAPI) {
  const config = resolveConfig()
  const googleCloudCli = findGoogleCloudCliPath()
  const discovery = await discoverVertexModels()
  const initialModels = discovery.ok ? discovery.models : VERTEX_MODELS
  if (!discovery.ok) {
    console.warn(`[vertex-anthropic] ${discovery.error} Using bundled model catalog.`)
  }
  let currentModels = initialModels
  let lastRefresh:
    | { ok: true; count: number; project: string; region: string }
    | { ok: false; error: string } = discovery.ok
    ? {
        ok: true,
        count: discovery.models.length,
        project: discovery.project,
        region: discovery.region,
      }
    : { ok: false, error: discovery.error }

  // Synchronous pre-registration to prevent race condition with scoped models
  try {
    const raw = readFileSync(SETTINGS_PATH, 'utf-8')
    const settings = JSON.parse(raw)
    const modelIds = collectPreRegisterModels(settings)

    if (modelIds.length > 0) {
      pi.registerProvider(PROVIDER_NAME, {
        baseUrl: `https://${buildEndpointHost(config.region)}`,
        api: API_NAME,
        apiKey: 'vertex-anthropic',
        models: modelIds.map((id) => stubModelForId(id, currentModels)),
        streamSimple: streamVertexAnthropic,
      })
    }
  } catch {
    // Non-fatal: pre-registration is best-effort
  }

  // Full provider registration with all models and /login support
  pi.registerProvider(PROVIDER_NAME, {
    baseUrl: `https://${buildEndpointHost(config.region)}`,
    api: API_NAME,
    apiKey: 'vertex-anthropic',

    oauth: {
      name: 'Google Cloud Vertex AI',

      async login(callbacks) {
        callbacks.onProgress?.('Setting up Google Cloud Vertex AI...')

        // Check if gcloud is installed
        try {
          const gcloudPath = googleCloudCli || findGoogleCloudCliPath()
          if (!gcloudPath) throw new Error('gcloud not found')
          spawn(gcloudPath, ['version'], { stdio: 'ignore', timeout: 2000 })
        } catch {
          const install = await callbacks.onPrompt({
            message:
              'gcloud CLI not found. Install Google Cloud SDK?\n\n' +
              'https://cloud.google.com/sdk/docs/install\n\n(y/n)',
          })

          if (install?.toLowerCase() === 'y') {
            callbacks.onAuth({
              url: 'https://cloud.google.com/sdk/docs/install',
              instructions: 'Install the Google Cloud SDK, then run /login again',
            })
            throw new Error('Please install gcloud CLI and run /login again')
          }
          throw new Error(
            'gcloud CLI required. Install from: https://cloud.google.com/sdk/docs/install',
          )
        }

        // Check authentication
        callbacks.onProgress?.('Checking gcloud authentication...')
        let needsAuth = false
        try {
          const gcloudPath = googleCloudCli || findGoogleCloudCliPath()
          if (!gcloudPath) throw new Error('gcloud not found')
          const token = exec(gcloudPath, ['auth', 'print-access-token'], { timeout: 5000 })
          needsAuth = !token || token.includes('ERROR') || token.length < 20
        } catch {
          needsAuth = true
        }

        if (needsAuth) {
          const doAuth = await callbacks.onPrompt({
            message: "Not authenticated with gcloud. Run 'gcloud auth login' now? (y/n)",
          })

          if (doAuth?.toLowerCase() === 'y') {
            callbacks.onProgress?.('Running gcloud auth login (a browser window will open)...')
            try {
              const gcloudPath = googleCloudCli || findGoogleCloudCliPath()
              if (!gcloudPath) throw new Error('gcloud not found')
              spawn(gcloudPath, ['auth', 'login'], { stdio: 'inherit' })
            } catch {
              throw new Error('Authentication failed. Please try: gcloud auth login')
            }
          } else {
            throw new Error('Authentication required. Run: gcloud auth login')
          }
        }

        // Configure project
        callbacks.onProgress?.('Configuring project...')
        let project =
          process.env.ANTHROPIC_VERTEX_PROJECT_ID || process.env.GOOGLE_CLOUD_PROJECT

        if (!project) {
          // Try current gcloud default
          try {
            const gcloudPath = googleCloudCli || findGoogleCloudCliPath()
            if (!gcloudPath) throw new Error('gcloud not found')
            const currentProject = exec(gcloudPath, ['config', 'get-value', 'project'], {
              timeout: 5000,
            })

            if (currentProject && currentProject !== '(unset)') {
              const use = await callbacks.onPrompt({
                message: `Use current project '${currentProject}'? (y/n)`,
              })
              if (use?.toLowerCase() === 'y') {
                project = currentProject
              }
            }
          } catch {
            // Ignore
          }

          if (!project) {
            let projectPrompt = 'Enter GCP project ID:'
            try {
              const gcloudPath = googleCloudCli || findGoogleCloudCliPath()
              if (!gcloudPath) throw new Error('gcloud not found')
              const projects = exec(
                gcloudPath,
                ['projects', 'list', '--format=value(projectId)'],
                { timeout: 10000 },
              )
                .split('\n')
                .filter((p) => p && p !== '(unset)')

              if (projects.length > 0 && projects.length < 20) {
                projectPrompt = `Available projects:\n${projects.map((p) => `  - ${p}`).join('\n')}\n\nEnter project ID:`
              }
            } catch {
              // Ignore
            }

            const projectInput = await callbacks.onPrompt({ message: projectPrompt })
            if (!projectInput || projectInput.trim() === '') {
              throw new Error('Project ID required')
            }
            project = projectInput.trim()

            try {
              const gcloudPath = googleCloudCli || findGoogleCloudCliPath()
              if (gcloudPath) {
                spawn(gcloudPath, ['config', 'set', 'project', project], { stdio: 'ignore' })
              }
            } catch {
              // Non-fatal
            }
          }
        }

        // Also set in process env for this session
        process.env.ANTHROPIC_VERTEX_PROJECT_ID = project

        // Configure region
        callbacks.onProgress?.('Configuring region...')
        let region =
          process.env.CLOUD_ML_REGION ||
          process.env.VERTEX_LOCATION ||
          process.env.VERTEXAI_LOCATION

        if (!region) {
          const regionChoice = await callbacks.onPrompt({
            message:
              'Select region:\n\n' +
              '  1. global (recommended for latest models)\n' +
              '  2. us-east5\n' +
              '  3. us-central1\n' +
              '  4. europe-west1\n' +
              '  5. asia-southeast1\n\n' +
              'Enter 1-5 or custom region name:',
          })

          region =
            REGION_CHOICES[regionChoice || ''] || regionChoice?.trim() || 'global'
          process.env.CLOUD_ML_REGION = region
        }

        // Check if Vertex AI API is enabled
        callbacks.onProgress?.('Checking Vertex AI API...')
        try {
          const gcloudPath = googleCloudCli || findGoogleCloudCliPath()
          if (!gcloudPath) throw new Error('gcloud not found')
          const enabled = exec(
            gcloudPath,
            [
              'services',
              'list',
              '--enabled',
              '--filter=name:aiplatform.googleapis.com',
              '--format=value(name)',
            ],
          )

          if (!enabled) {
            const enable = await callbacks.onPrompt({
              message: 'Vertex AI API not enabled. Enable it now? (y/n)',
            })

            if (enable?.toLowerCase() === 'y') {
              callbacks.onProgress?.('Enabling Vertex AI API (this may take a minute)...')
              spawn(gcloudPath, ['services', 'enable', 'aiplatform.googleapis.com'], {
                stdio: 'inherit',
              })
              callbacks.onProgress?.('Vertex AI API enabled!')
            } else {
              callbacks.onProgress?.(
                'API not enabled. Enable it manually:\n' +
                `  gcloud services enable aiplatform.googleapis.com --project=${project}`,
              )
            }
          }
        } catch {
          callbacks.onProgress?.(
            'Could not check API status. If requests fail, enable it manually:\n' +
            `  gcloud services enable aiplatform.googleapis.com --project=${project}`,
          )
        }

        // Test authentication
        callbacks.onProgress?.('Testing authentication...')
        try {
          const gcloudPath = googleCloudCli || findGoogleCloudCliPath()
          if (!gcloudPath) throw new Error('gcloud not found')
          const token = exec(gcloudPath, ['auth', 'print-access-token'], { timeout: 5000 })

          if (!token || token.length < 20) {
            throw new Error('Invalid token')
          }
        } catch {
          throw new Error('Authentication test failed. Please run: gcloud auth login')
        }

        callbacks.onProgress?.(
          `Configured successfully!\n` +
          `Project: ${project}\n` +
          `Region: ${region}\n` +
          `Settings persisted to ~/.pi/agent/auth.json.\n` +
          `If authentication fails later, run: gcloud auth login`,
        )

        return {
          refresh: Date.now().toString(),
          access: 'gcloud',
          expires: Date.now() + 1000 * 60 * 60 * 24 * 365,
          project,
          region,
        }
      },

      async refreshToken(credentials) {
        return { ...credentials, refresh: Date.now().toString() }
      },

      getApiKey() {
        try {
          return getGoogleCloudCliToken(googleCloudCli)
        } catch (error) {
          const msg = error instanceof Error ? error.message : 'Unknown error'
          throw new Error(`Failed to get access token: ${msg}\n\nRun: gcloud auth login`)
        }
      },
    },

    models: currentModels,
    async refreshModels(context) {
      if (context.signal?.aborted) return currentModels
      const result = await discoverVertexModels({ signal: context.signal })
      if (!result.ok) {
        lastRefresh = { ok: false, error: result.error }
        throw new Error(result.error)
      }
      currentModels = result.models
      lastRefresh = {
        ok: true,
        count: result.models.length,
        project: result.project,
        region: result.region,
      }
      return result.models
    },
    streamSimple: streamVertexAnthropic,
  })

  pi.registerCommand('vertex-anthropic-refresh-models', {
    description:
      'Refresh the Vertex Anthropic model catalog from your GCP project and region',
    handler: async (_args, ctx) => {
      try {
        await ctx.modelRegistry.refresh()
        if (!ctx.hasUI) return
        if (lastRefresh.ok) {
          ctx.ui.notify(
            `vertex-anthropic: refreshed ${lastRefresh.count} models for ${lastRefresh.project} (${lastRefresh.region})`,
            'info',
          )
        } else {
          ctx.ui.notify(`vertex-anthropic refresh failed: ${lastRefresh.error}`, 'error')
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        lastRefresh = { ok: false, error: message }
        if (ctx.hasUI) {
          ctx.ui.notify(`vertex-anthropic refresh failed: ${message}`, 'error')
        }
      }
    },
  })
}
