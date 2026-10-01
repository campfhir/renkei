# Changelog

All notable changes to this project are documented in this file.

## [Unreleased]

### Image Generation & Chat Enhancements
- **Chat preview window and download for generated pictures** (#299) - Users can now preview and download images generated within chat
- **Image chat improvements** (#298) - Added verbatim prompt display, inline pictures, preferred model selection, and usage ledger tracking
- **Dedicated image models** (#297) - Support for dedicated image generation models (gpt-image, FLUX)
- **SVG handling** (#295) - Save SVGs presented by the model as PNG or .svg files
- **Mass chat uploads** (#294) - Improved handling of bulk uploads with warning, file manifest, OCR for scans, and counter chip

### Sub-Agent Improvements
- **Sub-agent card reliability** (#293) - Fixed sub-agent card showing failed state while running; queued run modal no longer errors
- **Resilient code sub-agents** (#290) - Made code sub-agents resilient, long-running in auto mode, with elapsed time display
- **Queued message persistence** (#289) - Chat messages in queue now persist server-side and survive page reloads
- **Auto-detect Jira/GitHub issues** - Sub-agents now auto-detect relevant issues from pull requests in chats

### Voice & Response Latency
- **Voice improvements** (#271) - Voice recognition is faster with improved 1.2s close and streamed first words
- **Voice barge-in on words** - Voice barge-in now judges words instead of noise floor, allowing faster interruption
- **PR pipeline subscriptions** - Added webhooks, worker, and subscribe UI for monitoring PR pipelines

### Chat UI & Mobile Experience
- **Composer redesign** (#288) - Folded composer prompt, voice and dictation buttons into a two-level menu on phones in code projects
- **Code prompt rendering** (#277, #276) - Render code fences and backticks in chat prompts with line-number gutter
- **Mockup viewing** (#287) - Chats can now show mockups inline with a fullscreen zoomable viewer
- **Mobile table-card layout** (#292) - Keep mixed text and inline code in one mobile table-card value
- **Chat widget persistence** (#280) - Persist chat widget card decisions across devices
- **Widget decision batching** (#281) - Batch a reply's widget-card decisions before replying

### Code Project & Repository Integration
- **Project page layout** (#282) - Layout now reflects how often each part is used
- **Branch switching** (#276, #273, #272) - Improved branch picker UX with clickable options and mobile overflow menu
- **File management** - Added file management to the code pane; cascade gitignore dimming to folder subtrees with folder creation
- **PR/Commit/CI awareness** - Code projects now show PR, commit, and CI status cards with branch information
- **Host-agnostic repo adapter** - Support for both GitHub and Bitbucket with proper host detection
- **Git-host milestone cards** - Show git-host milestone cards only in code projects' chat

### Reliability & Session Management
- **Chat turn suspension/resumption** (#285) - Survive restarts mid-turn with suspend, resume, worker drain, and in-flight tool stopping
- **Code run timeout** (#286) - `code_run` now waits as long as the command may run
- **Sandbox checkout limits** (#291) - Raised sandbox checkout limit to 8GB with org settings and size requests

### Accessibility & UI Polish
- **Code block styling** (#277) - Made code block header/footer transparent, lightened dark mode appearance
- **Text contrast fix** (#277) - Fixed low-contrast code text in user prompt's blue bubble
- **ExternalLink component** (#274) - Migrated every external link to shared ExternalLink component for consistent handling
- **iOS PWA improvements** (#274) - Recover push subscriptions from inside the worker on iOS's silent rotation
- **Jira external links** - Open external Jira issue links in a new tab, not the iOS PWA webview

### Connector Enhancements

#### ADManager Plus
- **ADManager Plus connector** (#260, #265-267) - New connector for service-desk account actions
- **Password reset improvements** - Support for multiple reset-password templates and domainName in ModifyUser calls
- **Directory action cards** (#260) - Custom MCP preview widget card with group pill list and collapse functionality
- **Search query improvements** - Fixed space encoding, added EMPLOYEE_ID support, improved error logging
- **Reachability testing** - Fixed false "unreachable" errors on large ADManager Plus orgs

#### Entra Developer
- **Entra Developer connector** (#269) - New connector for provisioning Entra applications
- **API permissions & scopes** - Support for API permissions, exposed scopes, and portal links

#### Jira Integration
- **Dynamic field editing** (#257) - Approval edits can now touch any field, typed by live Jira schema
- **Field JSON strings** - Better handling of JSON string fields in Jira

### Infrastructure & Tooling
- **Worker kit extraction** - Extracted `@renkei/worker-kit` for shared plumbing across egress workers
- **CI improvements** (#296) - Warm the chat PATCH route in Playwright global setup
- **Docker publishing** (#261) - Publish renkei-admanager image as part of CI

### Security & Validation
- **Free domain blocking** (#279) - Block free/consumer email domains from self-service org registration
- **Tool settings per project** (#278) - Fix new project chats falling back to personal tool defaults

### Bug Fixes
- **Project chat tool defaults** - Fixed new project chats falling back to personal tool defaults
- **Model preview card** - Let the model settle a preview card on the person's word
- **Graph API concurrency** - Keep Graph calls inside Exchange's per-mailbox concurrency limit
- **Bitbucket host detection** - Fixed Bitbucket host detection for proper API endpoint routing
- **Branch switching dirty checkout** - Fixed errors when switching branches with uncommitted changes

## Release History

For previous releases and archived changes, refer to git history.

---

**Legend:**
- Numbers like `(#299)` refer to GitHub pull request numbers
- Features are grouped by functional area for easy navigation
- Breaking changes are highlighted where applicable
