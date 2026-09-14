# Natively Interview Knowledge MCP server

A local MCP server that lets any MCP client (Claude Desktop, Claude Code,
another agent) add companies and documents into Natively's free-tier
[Interview Knowledge](../docs/specs/oss-knowledge-rag-spec.md) feature —
without touching the app's UI, and without needing Natively open.

This is a **separate npm package on purpose** — see the comment at the top
of `index.mjs`. The main app's `better-sqlite3` is rebuilt for Electron's
Node ABI; an MCP client launches this as plain `node`, which needs its own,
differently-built `better-sqlite3`. Installing here keeps the two apart.

## Setup

Two ways to run it — pick whichever matches how you're registering it below.

**Option A — npx, no manual install** (works today, straight from this local
folder — nothing is published to the public npm registry):

```bash
npx --yes /absolute/path/to/natively-cluely-ai-assistant/mcp-server
```

This is the form to put directly into an MCP client's config (see below) —
the client runs it the same way, installing this folder's own dependencies
into a throwaway cache the first time and reusing that cache afterward.

**Option B — install once, run directly:**

```bash
cd mcp-server
npm install
node index.mjs
```

## Register with Claude Code

Add to your project's `.mcp.json` (create it at the repo root if it doesn't
exist yet):

```json
{
  "mcpServers": {
    "natively-interview-knowledge": {
      "command": "npx",
      "args": ["--yes", "/absolute/path/to/natively-cluely-ai-assistant/mcp-server"]
    }
  }
}
```

Or, if you'd rather run the already-installed copy (Option B above) instead
of letting npx manage it:

```json
{
  "mcpServers": {
    "natively-interview-knowledge": {
      "command": "node",
      "args": ["mcp-server/index.mjs"]
    }
  }
}
```

## Register with Claude Desktop or ChatGPT (MCP-compatible clients)

Add to the client's MCP config file (Claude Desktop:
`claude_desktop_config.json` — find its location for your OS in Claude
Desktop's own settings; ChatGPT's desktop app has an equivalent MCP servers
setting):

```json
{
  "mcpServers": {
    "natively-interview-knowledge": {
      "command": "npx",
      "args": ["--yes", "/absolute/path/to/natively-cluely-ai-assistant/mcp-server"]
    }
  }
}
```

Always use an absolute path here — unlike Claude Code, these clients don't
run from this repo's directory.

## Publishing to the public npm registry (optional, not done)

None of the above requires publishing anything — `npx <local-path>` runs
straight from this folder. If you'd rather have a client run
`npx natively-interview-knowledge-mcp` with no path at all (so it works on
someone else's machine without a clone of this repo), that requires actually
publishing this package to the public npm registry under an account you
control (`npm publish` from inside `mcp-server/`, after `npm login`) — a
deliberate, visible, external action nobody should take on your behalf
without you asking for it specifically.

## Tools

**Interview Knowledge:**
- `create_knowledge_company({ name, interviewerName?, contextNotes? })`
- `add_knowledge_document({ title, content, companyName?, docType? })` —
  `companyName` auto-creates the company if it doesn't exist yet.
  `docType` is one of `resume | company | interviewer | role | other`.
- `list_knowledge_companies()`
- `list_knowledge_documents({ companyName? })`

**Skills** (`electron/services/SkillsManager.ts`) — see
[`docs/skills/SKILL_AUTHORING.md`](../docs/skills/SKILL_AUTHORING.md) for the
full authoring guide before creating one:
- `create_skill({ name, description, instructions, overwrite? })` — writes a
  `SKILL.md` directly to Natively's skills folder. **`description` must
  include at least one double-quoted trigger phrase** (e.g. `Use when the
  user asks to "review this code"`) or the skill will never fire
  automatically — the tool warns if none is found.
- `list_skills()` — shows every installed skill and whether it has a working
  trigger phrase.

## How indexing works

This server only writes rows — it does not chunk or embed documents itself
(that needs the same on-device embedding pipeline the main app already
owns). A document added here is picked up and indexed automatically the next
time Natively is running and answers a question
(`InterviewKnowledgeRetriever.ensureAllIndexed()`, called before every
retrieval). Nothing needs to be done manually to trigger this.

## Where it writes

The same SQLite file Natively itself uses:
- Windows: `%APPDATA%\Natively\natively.db`
- macOS: `~/Library/Application Support/Natively/natively.db`
- Linux: `~/.config/Natively/natively.db`

It uses SQLite's WAL journal mode (the same mode the app sets) for safe
concurrent access whether or not Natively is running at the same time.
