import { join } from 'path'
import { homedir } from 'os'
import { stat } from 'fs/promises'

import { isSqliteAvailable, getSqliteLoadError, openDatabase } from '../sqlite.js'
import type { SqliteDatabase } from '../sqlite.js'
import { extractBashCommands } from '../bash-utils.js'
import { calculateCost } from '../models.js'
import type { Provider, SessionSource, SessionParser, ParsedProviderCall } from './types.js'

const modelDisplayNames: Record<string, string> = {
  'glm-5.1':                          'GLM 5.1',
  'minimax/minimax-m2.7':             'MiniMax M2.7',
  'nvidia/nemotron-3-super-120b-a12b': 'Nemotron 3 Super',
  'google/gemma-4-26b-a4b-it':        'Gemma 4 26B',
  'google/gemma-4-31b-it':            'Gemma 4 31B',
  'huihui-qwen3.5-27b-claude-4.6-opus-abliterated': 'Qwen3.5 27B Abli.',
  'anthropic/claude-opus-4.6':        'Opus 4.6',
  'anthropic/claude-sonnet-4.6':      'Sonnet 4.6',
  'anthropic/claude-sonnet-4':        'Sonnet 4',
  'anthropic/claude-haiku-4-5':       'Haiku 4.5',
  'openai/gpt-5':                     'GPT-5',
}

const toolNameMap: Record<string, string> = {
  read_file:           'Read',
  write_file:          'Edit',
  patch:               'Edit',
  search_files:        'Glob',
  terminal:            'Bash',
  execute_code:        'Bash',
  process:             'Bash',
  browser_navigate:   'Browse',
  browser_click:      'Browse',
  browser_type:       'Browse',
  browser_snapshot:   'Browse',
  browser_scroll:     'Browse',
  browser_press:      'Browse',
  browser_back:       'Browse',
  browser_vision:     'Browse',
  browser_console:   'Browse',
  browser_get_images: 'Browse',
  web_search:         'Search',
  web_extract:        'Search',
  delegate_task:      'Agent',
  memory:             'Memory',
  skill_manage:       'Skills',
  skill_view:         'Skills',
  skills_list:        'Skills',
  clarify:            'Clarify',
  text_to_speech:     'TTS',
  cronjob:            'Cron',
  vision_analyze:     'Vision',
  todo:               'Todo',
}

type SessionRow = {
  id: string
  source: string
  model: string
  input_tokens: number
  output_tokens: number
  cache_read_tokens: number
  cache_write_tokens: number
  reasoning_tokens: number
  message_count: number
  tool_call_count: number
  started_at: number
  ended_at: number | null
  title: string | null
}

type MessageRow = {
  id: number
  session_id: string
  role: string
  content: string | null
  tool_call_id: string | null
  tool_calls: string | null
  tool_name: string | null
  timestamp: number
  token_count: number | null
  finish_reason: string | null
}

function getHermesDir(override?: string): string {
  // The hermes dir IS the .hermes directory (or HERMES_HOME override)
  return override ?? process.env['HERMES_HOME'] ?? join(homedir(), '.hermes')
}

/** Normalize model name for CodeBurn's calculateCost lookup.
 *  Strips provider prefix and converts version dots to dashes
 *  (e.g. "anthropic/claude-opus-4.6" → "claude-opus-4-6") */
function normalizeModelForCost(model: string): string {
  const stripped = model.replace(/^(anthropic|openai|google|nvidia|minimax|huihui)\//, '')
  return stripped.replace(/(\d+)\.(\d+)/g, '$1-$2')
}

function getStateDbPath(hermesDir: string): string {
  return join(hermesDir, 'state.db')
}

function sanitizeProject(name: string): string {
  return name
    .replace(/^\//, '')
    .replace(/[/\\:]/g, '-')
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .slice(0, 80)
}

async function discoverSessionsInDb(dbPath: string): Promise<SessionSource[]> {
  const sources: SessionSource[] = []
  if (!isSqliteAvailable()) return sources

  let db: SqliteDatabase
  try {
    db = openDatabase(dbPath)
  } catch {
    return sources
  }

  try {
    const rows = db.query<SessionRow>(
      `SELECT id, source, model, input_tokens, output_tokens, cache_read_tokens,
              cache_write_tokens, reasoning_tokens, message_count, tool_call_count,
              started_at, ended_at, title
       FROM sessions
       WHERE input_tokens > 0
       ORDER BY started_at DESC`
    )

    for (const row of rows) {
      const project = row.title ?? row.source ?? 'hermes'
      sources.push({
        path: `${dbPath}:${row.id}`,
        project: sanitizeProject(project),
        provider: 'hermes',
      })
    }
  } catch {
    // Schema mismatch or other DB error
  } finally {
    db.close()
  }

  return sources
}

function extractToolCalls(toolCallsJson: string | null): {
  toolNames: string[]
  bashCommands: string[]
} {
  const toolNames: string[] = []
  const bashCommands: string[] = []
  if (!toolCallsJson) return { toolNames, bashCommands }

  try {
    const calls = JSON.parse(toolCallsJson)
    if (!Array.isArray(calls)) return { toolNames, bashCommands }

    for (const call of calls) {
      const name = call?.function?.name ?? call?.name ?? ''
      if (!name) continue
      toolNames.push(toolNameMap[name] ?? name)

      if (name === 'terminal' || name === 'execute_code') {
        try {
          const args = JSON.parse(call?.function?.arguments ?? '{}')
          const cmd = args.command ?? args.code ?? ''
          if (cmd) {
            for (const bc of extractBashCommands(cmd)) {
              if (!bashCommands.includes(bc)) bashCommands.push(bc)
            }
          }
        } catch { /* ignore */ }
      }
    }
  } catch { /* ignore */ }

  return { toolNames, bashCommands }
}

function createParser(
  source: SessionSource,
  seenKeys: Set<string>,
  hermesDir: string,
): SessionParser {
  return {
    async *parse(): AsyncGenerator<ParsedProviderCall> {
      if (!isSqliteAvailable()) {
        process.stderr.write(getSqliteLoadError() + '\n')
        return
      }

      // Path encodes session ID: ${dbPath}:${sessionId}
      const lastColon = source.path.lastIndexOf(':')
      const dbPath = source.path.slice(0, lastColon)
      const sessionId = source.path.slice(lastColon + 1)

      let db: SqliteDatabase
      try {
        db = openDatabase(dbPath)
      } catch (err) {
        process.stderr.write(
          `codeburn: hermes: cannot open state.db: ${err instanceof Error ? err.message : err}\n`
        )
        return
      }

      try {
        const sessions = db.query<SessionRow>(
          `SELECT id, source, model, input_tokens, output_tokens, cache_read_tokens,
                  cache_write_tokens, reasoning_tokens, message_count, tool_call_count,
                  started_at, ended_at, title
           FROM sessions
           WHERE id = ? AND input_tokens > 0`,
          [sessionId]
        )

        if (sessions.length === 0) return
        const session = sessions[0]

        const messages = db.query<MessageRow>(
          `SELECT id, session_id, role, content, tool_call_id, tool_calls,
                  tool_name, timestamp, token_count, finish_reason
           FROM messages
           WHERE session_id = ?
           ORDER BY id ASC`,
          [session.id]
        )

        if (messages.length === 0) return

        const turns: {
          assistantMsg: MessageRow
          toolNames: string[]
          bashCommands: string[]
          timestamp: number
          userMessage: string
        }[] = []

        let lastUserMessage = ''
        let pendingAssistant: MessageRow | null = null
        let pendingTools: string[] = []
        let pendingBashCommands: string[] = []
        let pendingUserMessage = '' // captured when assistant starts

        for (const msg of messages) {
          if (msg.role === 'user') {
            const content = msg.content ?? ''
            lastUserMessage = content.slice(0, 500).replace(/\n/g, ' ').trim()
            continue
          }

          if (msg.role === 'assistant') {
            // Flush any previous pending assistant turn
            if (pendingAssistant) {
              turns.push({
                assistantMsg: pendingAssistant,
                toolNames: [...pendingTools],
                bashCommands: [...pendingBashCommands],
                timestamp: pendingAssistant.timestamp,
                userMessage: pendingUserMessage,
              })
            }
            pendingAssistant = msg
            pendingUserMessage = lastUserMessage // capture the user message that triggered this response
            const extracted = extractToolCalls(msg.tool_calls)
            pendingTools = extracted.toolNames
            pendingBashCommands = extracted.bashCommands
            continue
          }

          if (msg.role === 'tool' && pendingAssistant) {
            const name = msg.tool_name
            if (name) {
              const displayName = toolNameMap[name] ?? name
              if (!pendingTools.includes(displayName)) {
                pendingTools.push(displayName)
              }
            }
            continue
          }
        }

        if (pendingAssistant) {
          turns.push({
            assistantMsg: pendingAssistant,
            toolNames: [...pendingTools],
            bashCommands: [...pendingBashCommands],
            timestamp: pendingAssistant.timestamp,
            userMessage: pendingUserMessage,
          })
        }

        if (turns.length === 0) return

        // Distribute session-level tokens proportionally across turns.
        // Hermes only stores cumulative totals per session, so we approximate:
        // - Input/cache-read split equally (shared context)
        // - Output/reasoning split proportionally by content length
        const sessionInputTokens     = session.input_tokens     ?? 0
        const sessionOutputTokens    = session.output_tokens    ?? 0
        const sessionCacheReadTokens  = session.cache_read_tokens  ?? 0
        const sessionCacheWriteTokens = session.cache_write_tokens ?? 0
        const sessionReasoningTokens  = session.reasoning_tokens  ?? 0

        const contentLengths = turns.map(t =>
          Math.max((t.assistantMsg.content ?? '').length, 1)
        )
        const totalContentLen = contentLengths.reduce((a, b) => a + b, 0)

        for (let i = 0; i < turns.length; i++) {
          const turn = turns[i]
          const weight = contentLengths[i] / totalContentLen

          const turnInputTokens = Math.round(sessionInputTokens / turns.length)
          const turnOutputTokens = Math.round(sessionOutputTokens * weight)
          const turnCacheReadTokens = Math.round(sessionCacheReadTokens / turns.length)
          const turnReasoningTokens = Math.round(sessionReasoningTokens * weight)

          if (turnInputTokens === 0 && turnOutputTokens === 0) continue

          const timestamp = new Date(turn.timestamp * 1000).toISOString()
          const dedupKey = `hermes:${session.id}:${turn.assistantMsg.id}`

          if (seenKeys.has(dedupKey)) continue
          seenKeys.add(dedupKey)

          const costUSD = calculateCost(
            normalizeModelForCost(session.model),
            turnInputTokens,
            turnOutputTokens + turnReasoningTokens,
            sessionCacheWriteTokens > 0
              ? Math.round(sessionCacheWriteTokens / turns.length)
              : 0,
            turnCacheReadTokens,
            0,
          )

          yield {
            provider: 'hermes',
            model: session.model,
            inputTokens: turnInputTokens,
            outputTokens: turnOutputTokens,
            cacheCreationInputTokens: sessionCacheWriteTokens > 0
              ? Math.round(sessionCacheWriteTokens / turns.length)
              : 0,
            cacheReadInputTokens: turnCacheReadTokens,
            cachedInputTokens: turnCacheReadTokens,
            reasoningTokens: turnReasoningTokens,
            webSearchRequests: turn.toolNames.includes('Search') ? 1 : 0,
            costUSD,
            tools: turn.toolNames,
            bashCommands: turn.bashCommands,
            timestamp,
            speed: 'standard',
            deduplicationKey: dedupKey,
            userMessage: turn.userMessage,
            sessionId: session.id,
          }
        }
      } finally {
        db.close()
      }
    },
  }
}

export function createHermesProvider(hermesDir?: string): Provider {
  const dir = getHermesDir(hermesDir)

  return {
    name: 'hermes',
    displayName: 'Hermes',

    modelDisplayName(model: string): string {
      const stripped = model.replace(/^(anthropic|openai|google|nvidia|minimax|huihui)\//, '')
      for (const [key, name] of Object.entries(modelDisplayNames)) {
        if (model === key || stripped === key) return name
        if (model.startsWith(key) || stripped.startsWith(key)) return name
      }
      return stripped.length < model.length ? stripped : model
    },

    toolDisplayName(rawTool: string): string {
      return toolNameMap[rawTool] ?? rawTool
    },

    async discoverSessions(): Promise<SessionSource[]> {
      if (!isSqliteAvailable()) return []

      const dbPath = getStateDbPath(dir)
      try {
        const s = await stat(dbPath)
        if (!s.isFile()) return []
      } catch {
        return []
      }

      return discoverSessionsInDb(dbPath)
    },

    createSessionParser(source: SessionSource, seenKeys: Set<string>): SessionParser {
      return createParser(source, seenKeys, dir)
    },
  }
}

export const hermes = createHermesProvider()