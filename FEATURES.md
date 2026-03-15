# Planned Features

## 1. Companion One-Click Install

The companion already compiles to a single standalone binary per platform. The goal is to reduce user setup to a single copy-paste command.

### User Flow

1. User goes to Settings > Companion > "Add Companion"
2. Web UI generates a one-liner with the token baked in:
   ```bash
   curl -fsSL https://app.zero-agent.com/install.sh | sh -s -- --token <generated-token>
   ```
3. User pastes it in their terminal
4. Script downloads the binary, runs it, companion connects
5. Web UI updates to "Connected" in real-time via WebSocket

### Implementation

**`install.sh` script (~50 lines):**
- Detect OS + arch via `uname -s` and `uname -m`
- Download the correct pre-built binary from CDN to `~/.zero-agent/bin/`
- Make it executable
- Run it with `--token` and `--server` flags baked in
- On macOS: offer to create a LaunchAgent plist so it auto-starts on login
- On Windows: provide a parallel PowerShell script (`install.ps1`)

**Web UI changes (CompanionManager.tsx):**
- When a token is created, show the install command (not just the raw token)
- Add a "copy" button for the command
- Show live connection status: "Waiting for companion..." → "Connected" (via existing WebSocket infra)

**Binary distribution:**
- Host pre-built binaries on CDN or GitHub Releases
- Naming convention: `zero-agent-companion-{os}-{arch}` (already exists in build scripts)
- Binaries: `darwin-arm64`, `darwin-x64`, `linux-x64`, `windows-x64.exe`

---

## 2. Unified Community Marketplace

A standalone page (`/marketplace`) combining community skills and workflow templates in one browsable destination. Replaces the current community browse modal.

### User Flow

1. User navigates to `/marketplace` (accessible from sidebar, not project-scoped)
2. Sees a unified feed of community skills and workflow templates
3. Can filter by type (All / Skills / Templates), search, sort by popular/newest
4. Clicks a skill → installs to their current project
5. Clicks a template → preview with customization (tweak prompt/schedule) → creates a scheduled task in their project

### Backend

**New table: `published_templates`**
```sql
CREATE TABLE published_templates (
  id TEXT PRIMARY KEY,
  name TEXT UNIQUE NOT NULL,
  description TEXT NOT NULL,
  prompt TEXT NOT NULL,
  schedule TEXT NOT NULL,
  required_tools TEXT,
  category TEXT,
  publisher_id TEXT NOT NULL,
  downloads INTEGER DEFAULT 0,
  published_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);
```

**New endpoints:**
- `GET /community/templates?q=&category=` — browse templates with search and filtering
- `POST /projects/:projectId/tasks/publish` — publish a scheduled task as a community template
- `POST /projects/:projectId/tasks/install-template` — install a template (creates a scheduled task, user can customize prompt/schedule before saving)

**New DB queries file:** `api/src/db/queries/published-templates.ts`

### Frontend

**New page: `web/src/pages/MarketplacePage.tsx`**
- Standalone page at `/marketplace`
- Tab bar: **All** | **Skills** | **Templates**
- Search input with debounce
- Sort toggle: Popular / Newest
- Filter pills: platform (for skills), category (for templates)
- Grid of cards using extended `SkillCard` component
- For templates: show schedule in human-readable form, category badge

**Changes to existing pages:**
- `SkillsPage.tsx`: replace "Add" button (currently opens `CommunityBrowseModal`) with a link to `/marketplace`
- `TasksPage.tsx`: add "Browse Templates" button linking to `/marketplace?type=templates`
- Sidebar/nav: add "Marketplace" entry

**Template install flow:**
1. User clicks "Use Template" on a template card
2. Modal shows: name, description, prompt (editable), schedule (editable), required tools
3. User picks a project (if not already in project context)
4. "Create Task" → POST to `/projects/:id/tasks/install-template`
5. Redirect to TasksPage showing the new task

### Seed Content

Ship 10-15 curated templates to bootstrap the marketplace:
- Daily email digest
- Monitor webpage for changes
- Weekly GitHub activity summary
- Stock price alerts
- Social media post scheduler
- Daily news briefing
- Competitor website monitor
- RSS feed summarizer
- Calendar prep (summarize today's meetings)
- Weekly project status report

---

## 3. WhatsApp Channel

Users can message their Zero-Agent companion via WhatsApp. We own the WhatsApp Business account and phone number — users just link their phone number in settings and start messaging.

### User Flow

1. User goes to Settings > WhatsApp
2. Enters their phone number (with country code)
3. Selects which project WhatsApp messages should route to
4. Saves — sees our WhatsApp number + QR code
5. Opens WhatsApp on their phone, messages our number
6. Agent responds in WhatsApp

### Architecture

```
User sends WhatsApp message
  → Meta webhook POST to our server
  → Extract sender phone number
  → Look up whatsapp_links table → find user + project
  → Find or create a chat for this phone/project pair
  → Run agent with project context, tools, skills
  → POST response back via Meta Graph API
  → User receives reply in WhatsApp
```

### Backend

**Environment variables (single set, not per-user):**
```
WHATSAPP_PHONE_NUMBER_ID=xxxxx
WHATSAPP_ACCESS_TOKEN=xxxxx
WHATSAPP_VERIFY_TOKEN=xxxxx
```

**New table: `whatsapp_links`**
```sql
CREATE TABLE whatsapp_links (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  phone TEXT NOT NULL UNIQUE,
  enabled INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now'))
);
```

**New route: `api/src/routes/webhooks/whatsapp.ts`**
- `GET /webhooks/whatsapp` — Meta verification handshake (return challenge token)
- `POST /webhooks/whatsapp` — incoming message handler:
  1. Extract sender phone from webhook payload
  2. Look up `whatsapp_links` by phone
  3. No match → reply with "This number isn't linked to an account. Link it at app.zero-agent.com/settings"
  4. Match found → find or create chat for this phone/project pair
  5. Run agent with project context
  6. Send response via `POST https://graph.facebook.com/v23.0/{PHONE_NUMBER_ID}/messages`

**New DB queries file:** `api/src/db/queries/whatsapp.ts`
- `getWhatsAppLinkByPhone(phone)` — lookup for incoming messages
- `getWhatsAppLinkByUser(userId)` — for settings page
- `createWhatsAppLink(userId, projectId, phone)`
- `updateWhatsAppLink(id, { projectId, enabled })`
- `deleteWhatsAppLink(id)`

**New API routes: `api/src/routes/whatsapp.ts`**
- `GET /whatsapp/link` — get current user's WhatsApp link
- `POST /whatsapp/link` — create/update link (phone + project)
- `DELETE /whatsapp/link` — remove link

**Message handling details:**
- Text messages → agent prompt
- Images/documents → download from Meta CDN, attach as files to project
- Agent response → split into WhatsApp-friendly chunks (4096 char limit per message)
- Track last message timestamp to know if within 24h free reply window
- No SDK needed — use direct `fetch()` calls to Graph API

### Frontend

**Settings page addition (SettingsPage.tsx):**
- New "WhatsApp" section:
  - Phone number input with country code picker
  - Project selector dropdown (which project receives messages)
  - Save / disconnect buttons
  - Once linked: display our WhatsApp number + QR code (wa.me link) so user can start messaging
  - Toggle to enable/disable without unlinking
  - Status indicator: "Linked" / "Not linked"

**New API hooks: `web/src/api/whatsapp.ts`**
- `useWhatsAppLink()` — fetch current link
- `useCreateWhatsAppLink()` — create/update
- `useDeleteWhatsAppLink()` — remove

### Edge Cases

- **User changes active project**: update `whatsapp_links.project_id` via settings
- **Message while agent is running**: queue the message, or reply "Still working on your last request..."
- **Media messages**: download from Meta, store as project files, include in agent context
- **24h window expiry**: if agent needs to send proactive messages (e.g. scheduled task results) after 24h of no user messages, requires an approved Meta template message
- **Unlinked number**: reply with instructions to link at the web app
- **Rate limiting**: respect Meta's quality rating system, don't spam users
- **Multiple projects**: user can only link one project at a time per phone number — switch via settings

### Costs

- Inbound conversations (user messages us, we reply within 24h): **free**
- Proactive outbound (template messages after 24h): ~$0.01-0.02 per message depending on region
- No monthly fee from Meta for the Cloud API itself

### Prerequisites

- Meta Business Verification (one-time, 1-2 weeks)
- Registered phone number for WhatsApp Business
- Approved message templates for any proactive outbound messaging
