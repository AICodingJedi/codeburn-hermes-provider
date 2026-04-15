# CodeBurn Hermes Provider

A [CodeBurn](https://github.com/AgentSeal/codeburn) provider plugin that reads token usage data from [Hermes Agent](https://github.com/AICodingJedi/hermes-agent) sessions and displays it in the CodeBurn TUI dashboard.

## How It Works

Hermes stores session data in a SQLite database (`~/.hermes/state.db`) with cumulative token counts at the **session level**, not per-message. This provider:

1. **Discovers** sessions by querying the `sessions` table for rows with `input_tokens > 0`
2. **Parses** messages from the `messages` table, grouping by assistant turns (assistant message + following tool result messages)
3. **Distributes** session-level token totals across turns:
   - **Input tokens** — split equally (all turns share the conversation context)
   - **Output tokens** — split proportionally by assistant content length
   - **Cache read tokens** — split equally (context caching is session-wide)
   - **Reasoning tokens** — split proportionally by content length
4. **Yields** one `ParsedProviderCall` per assistant turn with tool names mapped to CodeBurn display names

## Installation

### Option 1: Copy into CodeBurn source (recommended for now)

```bash
# Clone CodeBurn
git clone https://github.com/AgentSeal/codeburn.git
cd codeburn

# Copy provider file + types
cp path/to/codeburn-hermes-provider/src/providers/hermes.ts src/providers/hermes.ts
```

Then register the provider in `src/providers/index.ts`:

```typescript
import { hermes } from './hermes.js'

const coreProviders: Provider[] = [claude, codex, hermes]
```

### Option 2: Install as a standalone plugin

```bash
# Clone this repo
git clone https://github.com/AICodingJedi/codeburn-hermes-provider.git

# Build CodeBurn from source with the provider included
cp -r codeburn-hermes-provider/src/providers/hermes.ts /path/to/codeburn/src/providers/
```

> **Note:** CodeBurn doesn't yet support auto-discovering third-party provider plugins. Manual registration in `index.ts` is required. This is a planned feature — when it ships, installation will be a simple `npm install`.

### Dependencies

CodeBurn ships with `better-sqlite3` (used by the Cursor provider), so no extra install is needed when building from source. If you're using a CodeBurn binary install, you may need:

```bash
npm install -g better-sqlite3
```

## Configuration

### Custom Hermes Home Directory

If your Hermes data is not at the default `~/.hermes/`, set the `HERMES_HOME` environment variable:

```bash
export HERMES_HOME=/path/to/your/.hermes
```

Or create the provider programmatically:

```typescript
import { createHermesProvider } from './hermes.js'

const hermes = createHermesProvider('/custom/path/.hermes')
```

### Profiles

Hermes supports multiple profiles, each with its own `HERMES_HOME` directory. The provider reads from whichever directory `HERMES_HOME` points to (default: `~/.hermes`). To track a specific profile:

```bash
HERMES_HOME=~/.hermes/profiles/coder codeburn --provider hermes
```

Future versions may support multi-profile scanning.

## Tool Name Mapping

Hermes tool names are mapped to CodeBurn's display format:

| Hermes Tool | CodeBurn Display |
|-------------|-----------------|
| `read_file` | Read |
| `write_file`, `patch` | Edit |
| `search_files` | Glob |
| `terminal`, `execute_code`, `process` | Bash |
| `browser_*` (8 tools) | Browse |
| `web_search`, `web_extract` | Search |
| `delegate_task` | Agent |
| `memory` | Memory |
| `skill_*` (3 tools) | Skills |
| `clarify` | Clarify |
| `cronjob` | Cron |
| `vision_analyze` | Vision |
| `todo` | Todo |
| `text_to_speech` | TTS |

## Model Display Names

| Model ID | Display Name |
|----------|-------------|
| `glm-5.1` | GLM 5.1 |
| `minimax/minimax-m2.7` | MiniMax M2.7 |
| `nvidia/nemotron-3-super-120b-a12b` | Nemotron 3 Super |
| `google/gemma-4-26b-a4b-it` | Gemma 4 26B |
| `google/gemma-4-31b-it` | Gemma 4 31B |
| `huihui-qwen3.5-27b-*` | Qwen3.5 27B Abli. |
| `anthropic/claude-opus-4.6` | Opus 4.6 |
| `anthropic/claude-sonnet-4.6` | Sonnet 4.6 |
| `openai/gpt-5` | GPT-5 |

## Architecture

### Token Distribution Strategy

Hermes stores **cumulative** token counts at the session level — there is no per-message token breakdown. This is fundamentally different from Claude Code and Codex, which report per-turn token usage in their JSONL files.

Strategy: **proportional distribution**

- Input tokens → equal split across turns (all turns consume the same conversation context)
- Output tokens → proportional to content length (longer responses ≈ more output tokens)
- Cache tokens → equal split (context caching is session-wide)
- Reasoning tokens → proportional to output length

This is an approximation. If Hermes adds per-turn token tracking in the future, the provider will be updated to use exact values.

### SQLite Schema Dependencies

The provider reads from these tables in `~/.hermes/state.db`:

**sessions** — `id`, `model`, `input_tokens`, `output_tokens`, `cache_read_tokens`, `cache_write_tokens`, `reasoning_tokens`, `started_at`, `title`

**messages** — `id`, `session_id`, `role`, `content`, `tool_calls` (JSON), `tool_name`, `timestamp`, `finish_reason`

### SessionSource Design

Each Hermes session with `input_tokens > 0` becomes a `SessionSource` with:
- `path` → path to `state.db`
- `project` → session title (or source: cli/telegram/cron)
- `provider` → `'hermes'`

Multiple sessions share the same `path` (they're all in one database). The parser iterates through all sessions, using deduplication keys to prevent duplicate entries.

## Development

```bash
# Type-check (uses stub types for CodeBurn interfaces)
npm run typecheck

# The stubs in src/providers/types.ts and src/models.ts mirror
# CodeBurn's real interfaces. When installed into codeburn/src/,
# the real modules are used instead.
```

## Known Limitations

1. **Cost estimation** may show $0 for models not in CodeBurn's pricing table (common with custom/self-hosted models)
2. **Token distribution** is proportional, not exact — Hermes doesn't store per-turn tokens
3. **`cache_write_tokens`** has not been observed in the wild yet — support is implemented but untested
4. **`reasoning_tokens`** also zero in current data — proportional distribution code is in place

## License

MIT