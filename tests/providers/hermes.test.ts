import { mkdtemp, rm } from 'fs/promises'
import { mkdirSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { isSqliteAvailable } from '../../src/sqlite.js'
import { createHermesProvider } from '../../src/providers/hermes.js'
import type { ParsedProviderCall } from '../../src/providers/types.js'

type TestDb = {
  exec(sql: string): void
  prepare(sql: string): { run(...params: unknown[]): void }
  close(): void
}

let tmpDir: string

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'hermes-test-'))
})

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true })
})

function createTestDb(dir: string): string {
  // The hermes dir IS .hermes, so create state.db directly in it
  mkdirSync(dir, { recursive: true })
  const dbPath = join(dir, 'state.db')

  const Database = require('better-sqlite3')
  const db = new Database(dbPath)
  db.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      source TEXT,
      model TEXT,
      input_tokens INTEGER DEFAULT 0,
      output_tokens INTEGER DEFAULT 0,
      cache_read_tokens INTEGER DEFAULT 0,
      cache_write_tokens INTEGER DEFAULT 0,
      reasoning_tokens INTEGER DEFAULT 0,
      message_count INTEGER DEFAULT 0,
      tool_call_count INTEGER DEFAULT 0,
      started_at REAL,
      ended_at REAL,
      title TEXT
    )
  `)
  db.exec(`
    CREATE TABLE messages (
      id INTEGER PRIMARY KEY,
      session_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT,
      tool_call_id TEXT,
      tool_calls TEXT,
      tool_name TEXT,
      timestamp REAL,
      token_count INTEGER,
      finish_reason TEXT
    )
  `)
  db.close()
  return dbPath
}

function withTestDb(dbPath: string, fn: (db: TestDb) => void): void {
  const Database = require('better-sqlite3')
  const db = new Database(dbPath)
  fn(db)
  db.close()
}

function insertSession(
  db: TestDb,
  id: string,
  opts: {
    model?: string
    title?: string
    source?: string
    inputTokens?: number
    outputTokens?: number
    cacheReadTokens?: number
    cacheWriteTokens?: number
    reasoningTokens?: number
    startedAt?: number
  } = {},
): void {
  db.prepare(`
    INSERT INTO sessions (id, source, model, input_tokens, output_tokens,
      cache_read_tokens, cache_write_tokens, reasoning_tokens,
      message_count, tool_call_count, started_at, ended_at, title)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, NULL, ?)
  `).run(
    id,
    opts.source ?? 'cli',
    opts.model ?? 'anthropic/claude-opus-4.6',
    opts.inputTokens ?? 1000,
    opts.outputTokens ?? 500,
    opts.cacheReadTokens ?? 0,
    opts.cacheWriteTokens ?? 0,
    opts.reasoningTokens ?? 0,
    opts.startedAt ?? 1700000000,
    opts.title ?? 'My Project',
  )
}

function insertMessage(
  db: TestDb,
  id: number,
  sessionId: string,
  role: string,
  opts: {
    content?: string
    toolCalls?: string
    toolName?: string
    timestamp?: number
  } = {},
): void {
  db.prepare(`
    INSERT INTO messages (id, session_id, role, content, tool_call_id, tool_calls,
      tool_name, timestamp, token_count, finish_reason)
    VALUES (?, ?, ?, ?, NULL, ?, ?, ?, NULL, NULL)
  `).run(
    id,
    sessionId,
    role,
    opts.content ?? null,
    opts.toolCalls ?? null,
    opts.toolName ?? null,
    opts.timestamp ?? 1700000001,
  )
}

async function collectCalls(
  provider: ReturnType<typeof createHermesProvider>,
  dbPath: string,
  sessionId: string,
  seenKeys?: Set<string>,
): Promise<ParsedProviderCall[]> {
  const source = { path: `${dbPath}:${sessionId}`, project: 'My-Project', provider: 'hermes' }
  const calls: ParsedProviderCall[] = []
  for await (const call of provider.createSessionParser(source, seenKeys ?? new Set()).parse()) {
    calls.push(call)
  }
  return calls
}

const skipUnlessSqlite = isSqliteAvailable() ? describe : describe.skip

// ---------------------------------------------------------------------------
// Model display names
// ---------------------------------------------------------------------------

skipUnlessSqlite('hermes provider - model display names', () => {
  it('maps known models to display names', () => {
    const provider = createHermesProvider()
    expect(provider.modelDisplayName('anthropic/claude-opus-4.6')).toBe('Opus 4.6')
    expect(provider.modelDisplayName('anthropic/claude-sonnet-4.6')).toBe('Sonnet 4.6')
    expect(provider.modelDisplayName('openai/gpt-5')).toBe('GPT-5')
  })

  it('strips provider prefix for lookup', () => {
    const provider = createHermesProvider()
    expect(provider.modelDisplayName('anthropic/claude-opus-4.6')).toBe('Opus 4.6')
  })

  it('returns stripped prefix for unknown models with provider prefix', () => {
    const provider = createHermesProvider()
    expect(provider.modelDisplayName('google/unknown-model')).toBe('unknown-model')
  })

  it('returns unknown models without prefix as-is', () => {
    const provider = createHermesProvider()
    expect(provider.modelDisplayName('big-pickle')).toBe('big-pickle')
  })

  it('has correct displayName and name', () => {
    const provider = createHermesProvider()
    expect(provider.displayName).toBe('Hermes')
    expect(provider.name).toBe('hermes')
  })
})

// ---------------------------------------------------------------------------
// Tool display names
// ---------------------------------------------------------------------------

skipUnlessSqlite('hermes provider - tool display names', () => {
  it('maps hermes builtins', () => {
    const provider = createHermesProvider()
    expect(provider.toolDisplayName('terminal')).toBe('Bash')
    expect(provider.toolDisplayName('execute_code')).toBe('Bash')
    expect(provider.toolDisplayName('read_file')).toBe('Read')
    expect(provider.toolDisplayName('patch')).toBe('Edit')
    expect(provider.toolDisplayName('web_search')).toBe('Search')
    expect(provider.toolDisplayName('delegate_task')).toBe('Agent')
    expect(provider.toolDisplayName('browser_navigate')).toBe('Browse')
    expect(provider.toolDisplayName('memory')).toBe('Memory')
  })

  it('returns unknown tools as-is', () => {
    const provider = createHermesProvider()
    expect(provider.toolDisplayName('custom_mcp_tool')).toBe('custom_mcp_tool')
  })
})

// ---------------------------------------------------------------------------
// Session discovery
// ---------------------------------------------------------------------------

skipUnlessSqlite('hermes provider - session discovery', () => {
  it('discovers sessions with correct path format', async () => {
    const dbPath = createTestDb(tmpDir)
    withTestDb(dbPath, (db) => {
      insertSession(db, 'sess-1')
    })

    const provider = createHermesProvider(tmpDir)
    const sessions = await provider.discoverSessions()

    expect(sessions).toHaveLength(1)
    expect(sessions[0]!.provider).toBe('hermes')
    expect(sessions[0]!.path).toBe(`${dbPath}:sess-1`)
  })

  it('sanitizes project name from title', async () => {
    const dbPath = createTestDb(tmpDir)
    withTestDb(dbPath, (db) => {
      insertSession(db, 'sess-1', { title: 'My/Weird:Project\\Name' })
    })

    const provider = createHermesProvider(tmpDir)
    const sessions = await provider.discoverSessions()
    expect(sessions[0]!.project).toBe('My-Weird-Project-Name')
  })

  it('uses source as fallback when title is null', async () => {
    const dbPath = createTestDb(tmpDir)
    withTestDb(dbPath, (db) => {
      db.prepare(`
        INSERT INTO sessions (id, source, model, input_tokens, output_tokens,
          cache_read_tokens, cache_write_tokens, reasoning_tokens,
          message_count, tool_call_count, started_at, ended_at, title)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, NULL, NULL)
      `).run('sess-1', 'telegram', 'anthropic/claude-opus-4.6', 1000, 500, 0, 0, 0, 1700000000)
    })

    const provider = createHermesProvider(tmpDir)
    const sessions = await provider.discoverSessions()
    expect(sessions[0]!.project).toBe('telegram')
  })

  it('excludes sessions with zero input tokens', async () => {
    const dbPath = createTestDb(tmpDir)
    withTestDb(dbPath, (db) => {
      insertSession(db, 'sess-empty', { inputTokens: 0, outputTokens: 0 })
    })

    const provider = createHermesProvider(tmpDir)
    const sessions = await provider.discoverSessions()
    expect(sessions).toHaveLength(0)
  })

  it('returns empty for non-existent hermes dir', async () => {
    const provider = createHermesProvider('/nonexistent/path')
    const sessions = await provider.discoverSessions()
    expect(sessions).toEqual([])
  })

  it('returns empty for empty database', async () => {
    createTestDb(tmpDir)
    const provider = createHermesProvider(tmpDir)
    const sessions = await provider.discoverSessions()
    expect(sessions).toEqual([])
  })

  it('discovers multiple sessions', async () => {
    const dbPath = createTestDb(tmpDir)
    withTestDb(dbPath, (db) => {
      insertSession(db, 'sess-1', { title: 'Project A' })
      insertSession(db, 'sess-2', { title: 'Project B' })
    })

    const provider = createHermesProvider(tmpDir)
    const sessions = await provider.discoverSessions()
    expect(sessions).toHaveLength(2)
  })

  it('truncates long project names to 80 chars', async () => {
    const dbPath = createTestDb(tmpDir)
    const longTitle = 'A'.repeat(200)
    withTestDb(dbPath, (db) => {
      insertSession(db, 'sess-1', { title: longTitle })
    })

    const provider = createHermesProvider(tmpDir)
    const sessions = await provider.discoverSessions()
    expect(sessions[0]!.project.length).toBe(80)
  })
})

// ---------------------------------------------------------------------------
// Session parsing
// ---------------------------------------------------------------------------

skipUnlessSqlite('hermes provider - session parsing', () => {
  it('parses single assistant turn with proportional token distribution', async () => {
    const dbPath = createTestDb(tmpDir)
    withTestDb(dbPath, (db) => {
      insertSession(db, 'sess-1', {
        inputTokens: 1000,
        outputTokens: 500,
        cacheReadTokens: 200,
        reasoningTokens: 100,
      })

      insertMessage(db, 1, 'sess-1', 'user', { content: 'fix the login bug' })
      insertMessage(db, 2, 'sess-1', 'assistant', {
        content: 'I will fix the login bug by...',
        toolCalls: JSON.stringify([
          { function: { name: 'read_file', arguments: '{"path":"/src/login.ts"}' } },
          { function: { name: 'terminal', arguments: '{"command":"npm test"}' } },
        ]),
      })
      insertMessage(db, 3, 'sess-1', 'tool', { toolName: 'read_file' })
    })

    const provider = createHermesProvider(tmpDir)
    const calls = await collectCalls(provider, dbPath, 'sess-1')

    expect(calls).toHaveLength(1)
    const call = calls[0]!
    expect(call.provider).toBe('hermes')
    expect(call.model).toBe('anthropic/claude-opus-4.6')
    // Single turn gets all session tokens
    expect(call.inputTokens).toBe(1000)
    expect(call.outputTokens).toBe(500)
    expect(call.cacheReadInputTokens).toBe(200)
    expect(call.cachedInputTokens).toBe(200)
    expect(call.reasoningTokens).toBe(100)
    expect(call.tools).toEqual(['Read', 'Bash'])
    expect(call.bashCommands).toEqual(['npm'])
    expect(call.userMessage).toBe('fix the login bug')
    expect(call.sessionId).toBe('sess-1')
    expect(call.speed).toBe('standard')
    expect(call.deduplicationKey).toBe('hermes:sess-1:2')
  })

  it('distributes tokens proportionally across multiple turns', async () => {
    const dbPath = createTestDb(tmpDir)
    withTestDb(dbPath, (db) => {
      insertSession(db, 'sess-1', {
        inputTokens: 3000,
        outputTokens: 2000,
        cacheReadTokens: 600,
        reasoningTokens: 400,
      })

      insertMessage(db, 1, 'sess-1', 'user', { content: 'first question' })
      // Short assistant response (25% of total content length)
      insertMessage(db, 2, 'sess-1', 'assistant', { content: 'Ok.' })

      insertMessage(db, 3, 'sess-1', 'user', { content: 'second question' })
      // Long assistant response (75% of total content length)
      insertMessage(db, 4, 'sess-1', 'assistant', { content: 'Here is a very detailed and long response that explains everything thoroughly.' })
    })

    const provider = createHermesProvider(tmpDir)
    const calls = await collectCalls(provider, dbPath, 'sess-1')

    expect(calls).toHaveLength(2)
    // Input tokens split equally: 3000 / 2 = 1500 each
    expect(calls[0]!.inputTokens).toBe(1500)
    expect(calls[1]!.inputTokens).toBe(1500)
    // Cache read split equally: 600 / 2 = 300 each
    expect(calls[0]!.cacheReadInputTokens).toBe(300)
    expect(calls[1]!.cacheReadInputTokens).toBe(300)
    // Output tokens proportional by content length
    // Short=3 chars ("Ok."), Long=75 chars; weights: 3/78, 75/78
    const shortOutput = calls[0]!.outputTokens
    const longOutput = calls[1]!.outputTokens
    expect(longOutput).toBeGreaterThan(shortOutput)
    // Reasonably close to total
    expect(shortOutput + longOutput).toBeGreaterThanOrEqual(1990) // rounding tolerance
  })

  it('skips turns with zero distributed tokens', async () => {
    const dbPath = createTestDb(tmpDir)
    withTestDb(dbPath, (db) => {
      insertSession(db, 'sess-1', { inputTokens: 0, outputTokens: 0 })

      insertMessage(db, 1, 'sess-1', 'user', { content: 'hello' })
      insertMessage(db, 2, 'sess-1', 'assistant', { content: 'hi' })
    })

    const provider = createHermesProvider(tmpDir)
    const calls = await collectCalls(provider, dbPath, 'sess-1')
    expect(calls).toHaveLength(0)
  })

  it('deduplicates across parses', async () => {
    const dbPath = createTestDb(tmpDir)
    withTestDb(dbPath, (db) => {
      insertSession(db, 'sess-1', { inputTokens: 1000, outputTokens: 500 })
      insertMessage(db, 1, 'sess-1', 'user', { content: 'hello' })
      insertMessage(db, 2, 'sess-1', 'assistant', { content: 'hi there' })
    })

    const provider = createHermesProvider(tmpDir)
    const seenKeys = new Set<string>()
    const calls1 = await collectCalls(provider, dbPath, 'sess-1', seenKeys)
    const calls2 = await collectCalls(provider, dbPath, 'sess-1', seenKeys)

    expect(calls1).toHaveLength(1)
    expect(calls2).toHaveLength(0)
    expect(seenKeys.has('hermes:sess-1:2')).toBe(true)
  })

  it('uses calculateCost for known models', async () => {
    const dbPath = createTestDb(tmpDir)
    withTestDb(dbPath, (db) => {
      insertSession(db, 'sess-1', {
        model: 'anthropic/claude-opus-4.6',
        inputTokens: 1000,
        outputTokens: 500,
      })
      insertMessage(db, 1, 'sess-1', 'user', { content: 'hello' })
      insertMessage(db, 2, 'sess-1', 'assistant', { content: 'hi' })
    })

    const provider = createHermesProvider(tmpDir)
    const calls = await collectCalls(provider, dbPath, 'sess-1')

    expect(calls).toHaveLength(1)
    // calculateCost for a known model should return a positive value
    expect(calls[0]!.costUSD).toBeGreaterThan(0)
  })

  it('returns cost as $0 for unknown models', async () => {
    const dbPath = createTestDb(tmpDir)
    withTestDb(dbPath, (db) => {
      insertSession(db, 'sess-1', {
        model: 'totally-unknown-model-xyz',
        inputTokens: 1000,
        outputTokens: 500,
      })
      insertMessage(db, 1, 'sess-1', 'user', { content: 'hello' })
      insertMessage(db, 2, 'sess-1', 'assistant', { content: 'hi' })
    })

    const provider = createHermesProvider(tmpDir)
    const calls = await collectCalls(provider, dbPath, 'sess-1')

    expect(calls).toHaveLength(1)
    expect(calls[0]!.costUSD).toBe(0)
  })

  it('extracts bash commands via extractBashCommands', async () => {
    const dbPath = createTestDb(tmpDir)
    withTestDb(dbPath, (db) => {
      insertSession(db, 'sess-1')
      insertMessage(db, 1, 'sess-1', 'user', { content: 'build it' })
      insertMessage(db, 2, 'sess-1', 'assistant', {
        toolCalls: JSON.stringify([
          { function: { name: 'terminal', arguments: '{"command":"npm test && git push"}' } },
        ]),
      })
    })

    const provider = createHermesProvider(tmpDir)
    const calls = await collectCalls(provider, dbPath, 'sess-1')

    expect(calls).toHaveLength(1)
    expect(calls[0]!.bashCommands).toEqual(['npm', 'git'])
  })

  it('extracts tools from tool result messages', async () => {
    const dbPath = createTestDb(tmpDir)
    withTestDb(dbPath, (db) => {
      insertSession(db, 'sess-1')
      insertMessage(db, 1, 'sess-1', 'user', { content: 'search for X' })
      insertMessage(db, 2, 'sess-1', 'assistant', {
        toolCalls: JSON.stringify([
          { function: { name: 'web_search', arguments: '{"query":"X"}' } },
        ]),
      })
      // Tool result with a different name
      insertMessage(db, 3, 'sess-1', 'tool', { toolName: 'browser_navigate' })
    })

    const provider = createHermesProvider(tmpDir)
    const calls = await collectCalls(provider, dbPath, 'sess-1')

    expect(calls).toHaveLength(1)
    expect(calls[0]!.tools).toEqual(['Search', 'Browse'])
  })

  it('handles corrupt tool_calls JSON gracefully', async () => {
    const dbPath = createTestDb(tmpDir)
    withTestDb(dbPath, (db) => {
      insertSession(db, 'sess-1')
      insertMessage(db, 1, 'sess-1', 'user', { content: 'hello' })
      insertMessage(db, 2, 'sess-1', 'assistant', {
        content: 'valid content',
        toolCalls: 'not valid json {]',
      })
    })

    const provider = createHermesProvider(tmpDir)
    const calls = await collectCalls(provider, dbPath, 'sess-1')
    expect(calls).toHaveLength(1)
    expect(calls[0]!.tools).toEqual([])
  })

  it('skips non-user non-assistant roles', async () => {
    const dbPath = createTestDb(tmpDir)
    withTestDb(dbPath, (db) => {
      insertSession(db, 'sess-1')
      insertMessage(db, 1, 'sess-1', 'system', { content: 'You are helpful' })
    })

    const provider = createHermesProvider(tmpDir)
    const calls = await collectCalls(provider, dbPath, 'sess-1')
    expect(calls).toHaveLength(0)
  })

  it('returns empty for invalid db path', async () => {
    const provider = createHermesProvider(tmpDir)
    const source = { path: '/nonexistent/db.db:sess-1', project: 'test', provider: 'hermes' }
    const calls: ParsedProviderCall[] = []
    for await (const call of provider.createSessionParser(source, new Set()).parse()) calls.push(call)
    expect(calls).toHaveLength(0)
  })

  it('tracks user messages per assistant response', async () => {
    const dbPath = createTestDb(tmpDir)
    withTestDb(dbPath, (db) => {
      insertSession(db, 'sess-1', { inputTokens: 200, outputTokens: 200 })

      insertMessage(db, 1, 'sess-1', 'user', { content: 'first question' })
      insertMessage(db, 2, 'sess-1', 'assistant', { content: 'first answer here' })

      insertMessage(db, 3, 'sess-1', 'user', { content: 'second question' })
      insertMessage(db, 4, 'sess-1', 'assistant', { content: 'second answer here with more content for proportional split' })
    })

    const provider = createHermesProvider(tmpDir)
    const calls = await collectCalls(provider, dbPath, 'sess-1')
    expect(calls).toHaveLength(2)
    expect(calls[0]!.userMessage).toBe('first question')
    expect(calls[1]!.userMessage).toBe('second question')
  })

  it('yields nothing for session with only user messages', async () => {
    const dbPath = createTestDb(tmpDir)
    withTestDb(dbPath, (db) => {
      insertSession(db, 'sess-1')
      insertMessage(db, 1, 'sess-1', 'user', { content: 'hello?' })
    })

    const provider = createHermesProvider(tmpDir)
    const calls = await collectCalls(provider, dbPath, 'sess-1')
    expect(calls).toHaveLength(0)
  })

  it('converts unix-epoch timestamps to ISO strings', async () => {
    const dbPath = createTestDb(tmpDir)
    withTestDb(dbPath, (db) => {
      insertSession(db, 'sess-1')
      insertMessage(db, 1, 'sess-1', 'user', { content: 'hello', timestamp: 1700000000 })
      insertMessage(db, 2, 'sess-1', 'assistant', { content: 'hi', timestamp: 1700000001 })
    })

    const provider = createHermesProvider(tmpDir)
    const calls = await collectCalls(provider, dbPath, 'sess-1')
    expect(calls[0]!.timestamp).toBe(new Date(1700000001 * 1000).toISOString())
  })

  it('sets webSearchRequests when web_search tool is used', async () => {
    const dbPath = createTestDb(tmpDir)
    withTestDb(dbPath, (db) => {
      insertSession(db, 'sess-1')
      insertMessage(db, 1, 'sess-1', 'user', { content: 'search' })
      insertMessage(db, 2, 'sess-1', 'assistant', {
        toolCalls: JSON.stringify([
          { function: { name: 'web_search', arguments: '{"query":"test"}' } },
        ]),
      })
    })

    const provider = createHermesProvider(tmpDir)
    const calls = await collectCalls(provider, dbPath, 'sess-1')
    expect(calls[0]!.webSearchRequests).toBe(1)
  })

  it('distributes cache write tokens equally across turns', async () => {
    const dbPath = createTestDb(tmpDir)
    withTestDb(dbPath, (db) => {
      insertSession(db, 'sess-1', {
        inputTokens: 2000,
        outputTokens: 1000,
        cacheWriteTokens: 400,
      })

      insertMessage(db, 1, 'sess-1', 'user', { content: 'q1' })
      insertMessage(db, 2, 'sess-1', 'assistant', { content: 'answer one here' })

      insertMessage(db, 3, 'sess-1', 'user', { content: 'q2' })
      insertMessage(db, 4, 'sess-1', 'assistant', { content: 'answer two here also' })
    })

    const provider = createHermesProvider(tmpDir)
    const calls = await collectCalls(provider, dbPath, 'sess-1')

    expect(calls).toHaveLength(2)
    // 400 / 2 = 200 each
    expect(calls[0]!.cacheCreationInputTokens).toBe(200)
    expect(calls[1]!.cacheCreationInputTokens).toBe(200)
  })
})