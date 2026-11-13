# AGENTS.md

## Project Overview

**Interview Coder CN** (截屏解题助手) is a desktop application that captures screenshots of on-screen problems (coding challenges, exam questions, or anything else) and uses AI (vision models) to generate solutions in real-time. The window is invisible to screen-sharing software, making it suitable for use during coding interviews and online assessments.

Key capabilities:

- Global shortcuts trigger screenshot capture → AI analysis → streamed solution display
- Frameless, transparent, always-on-top overlay window invisible to screen-sharing
- Mouse passthrough mode (window ignores mouse events)
- Multi-screenshot conversation continuity (append screenshots to existing context)
- Follow-up questions within the same conversation
- Real-time speech transcription (DashScope Fun-ASR) — transcribed text is attached to screenshots when sent to AI
- Configurable AI provider (OpenAI, SiliconFlow, OpenRouter, or any OpenAI-compatible API)

## Tech Stack

| Layer     | Technology                                                            |
| --------- | --------------------------------------------------------------------- |
| Framework | Electron 37 (electron-vite 4)                                         |
| Frontend  | React 19, TypeScript 5.8                                              |
| Styling   | Tailwind CSS v4, shadcn/ui (New York style), Radix primitives         |
| State     | Zustand 5 (5 stores, 2 with localStorage persistence)                 |
| Routing   | react-router v7 (HashRouter, 3 routes)                                |
| AI        | Vercel AI SDK (`ai` + `@ai-sdk/openai`), streaming via `streamText()` |
| Build     | electron-vite (Vite 7), electron-builder 25                           |
| Linting   | ESLint 9 (flat config), Prettier                                      |

## Directory Structure

```
src/
├── main/                    # Electron main process
│   ├── index.ts             # App entry: lifecycle, error handling, app.whenReady()
│   ├── main-window.ts       # BrowserWindow creation (frameless, transparent, always-on-top)
│   ├── toolbar-window.ts    # Overlay toolbar window: bounds/visibility/opacity glued to main window
│   ├── shortcuts.ts         # Global shortcuts registration + AI streaming orchestration (largest file)
│   ├── ai.ts                # Vercel AI SDK integration, 3 streaming functions
│   ├── settings.ts          # App settings object + IPC handlers
│   ├── state.ts             # App state object + IPC handlers
│   ├── take-screenshot.ts   # desktopCapturer → base64 PNG
│   ├── transcription.ts     # DashScope WebSocket real-time speech-to-text
│   ├── auto-updater.ts      # electron-updater (non-macOS only)
│   ├── interview-record.ts  # Interview transcript → daily Markdown log (best-effort)
│   └── index.d.ts           # global.mainWindow type declaration
├── preload/
│   ├── index.ts             # contextBridge API: exposes window.api to renderer
│   └── index.d.ts           # Type declarations for window.electron and window.api
└── renderer/
    ├── index.html            # SPA entry
    └── src/
        ├── main.tsx          # React root render
        ├── App.tsx           # Router + settings sync + shortcut init + Toaster
        ├── coder/            # Main page: screenshot display + AI solution stream
        │   ├── index.tsx     # CoderPage layout + state sync + transcription lifecycle
        │   ├── AppHeader.tsx # Draggable title bar with nav buttons
        │   ├── AppContent.tsx# Screenshots gallery + markdown solution + error banner
        │   ├── AppStatusBar.tsx    # Loading indicator, follow-up dialog, shortcut hints
        │   ├── TranscriptionBar.tsx # Absolute-positioned real-time transcription overlay
        │   ├── OverlayToolbar.tsx  # Contents of the toolbar window (route `/toolbar`)
        │   └── PrerequisitesChecker.tsx  # Modal for API key setup
        ├── settings/         # Settings page
        │   ├── index.tsx     # AI config, coding, appearance, shortcuts, save folders, privacy
        │   ├── SelectModel.tsx     # Combobox with custom model input
        │   └── CustomShortcuts.tsx # Shortcut key recorder
        ├── help/             # Help page
        │   ├── index.tsx     # Quick start guide, shortcuts, toolbar, FAQ
        │   ├── Shortcuts.tsx
        │   ├── OverlayToolbar.tsx  # Toolbar section (buttons + meanings + shortcuts)
        │   ├── FAQ.tsx
        │   └── components/index.tsx  # HelpSection wrapper
        ├── components/
        │   ├── MarkdownRenderer.tsx   # react-markdown + remark-gfm + rehype-highlight
        │   ├── ShortcutRenderer.tsx   # Platform-aware shortcut key badges
        │   └── ui/           # shadcn/ui primitives (button, dialog, select, etc.)
        ├── lib/
        │   ├── store/        # Zustand stores
        │   │   ├── app.ts       # ignoreMouse state, synced from main process
        │   │   ├── settings.ts  # API config, model, prompt scenes, opacity, toolbar (persisted v6)
        │   │   ├── shortcuts.ts # Shortcut bindings (persisted v5, with migration)
        │   │   ├── solution.ts  # Loading state, solution chunks, screenshots, errors
        │   │   └── transcription.ts # Transcription state: isTranscribing, text, error
        │   ├── toolbar-actions.ts # Toolbar buttons + resolveToolbarAction(), shared with help
        │   ├── utils/
        │   │   ├── index.ts     # cn() helper, getCloneableFields()
        │   │   ├── env.ts       # isMac, platformAlt
        │   │   └── keyboard.ts  # Accelerator string conversion
        │   └── audio-capture.ts # System audio capture via getDisplayMedia for transcription
        └── assets/
            ├── base.css      # Tailwind @import, CSS variables, app layout styles
            └── main.css      # Tailwind + typography plugin + theme variables (oklch)
```

## Architecture

### Process Model

```
┌─────────────────────────────────────────────────────┐
│  Main Process (src/main/)                           │
│  ┌──────────┐  ┌──────────┐  ┌───────────────────┐ │
│  │ settings │  │  state   │  │    shortcuts.ts    │ │
│  │   .ts    │  │   .ts    │  │  (orchestrator)   │ │
│  └────┬─────┘  └────┬─────┘  │  - global hotkeys │ │
│       │              │        │  - AI streaming   │ │
│       │              │        │  - conversation   │ │
│       │              │        │    management     │ │
│       │              │        └──┬───────────┬────┘ │
│       │              │           │           │      │
│       │              │     ┌─────┴──┐  ┌─────┴────┐ │
│       │              │     │ ai.ts  │  │take-     │ │
│       │              │     │        │  │screenshot│ │
│       │              │     └────────┘  └──────────┘ │
│       └──────────────┼───────────┘                  │
│              IPC (ipcMain.handle)                    │
├─────────────────────────────────────────────────────┤
│  Preload (src/preload/)                             │
│  contextBridge → window.api                         │
├─────────────────────────────────────────────────────┤
│  Renderer (src/renderer/)                           │
│  React app with Zustand stores                      │
│  window.api.on*() for events from main              │
│  window.api.*() for invoke calls to main            │
└─────────────────────────────────────────────────────┘
```

### Data Flow: Screenshot → Solution

1. User presses a global shortcut, or dwells on the toolbar’s camera button
2. `shortcuts.ts` sends `ai-loading-start` **before** capturing: `takeScreenshot()`
   encodes the full-screen PNG synchronously on the main thread, so waiting for it
   first makes a hover-triggered capture look like the bar did nothing at all
3. `takeScreenshot()` → `desktopCapturer` → `toPNG()` → base64. Every capture appends
   its `getSources` / `toPNG` / `base64` / `total` split to `<userData>/perf.log` — that
   file is the first thing to read when the app hitches after a screenshot. Cursor
   polling is suspended for the duration (`suspendCursorTracking`), otherwise samples
   queue up on the interval and arrive in a burst once the thread frees up
4. Main sends `screenshot-taken` to renderer
5. Main calls `getSolutionStream(base64Image)` → Vercel AI SDK `streamText()`
6. Stream chunks sent to renderer via `solution-chunk` IPC events
7. Renderer accumulates chunks in `useSolutionStore` and renders via `MarkdownRenderer`
8. On completion: `solution-complete`; on error: `solution-error`; on abort: `solution-stopped`

### IPC Channels

**Renderer → Main (invoke):**

- `getAppSettings` / `updateAppSettings` — settings CRUD
- `updateAppState` — sync `inCoderPage`, `ignoreMouse`
- `initShortcuts` / `getShortcuts` / `updateShortcuts` — shortcut management
- `stopSolutionStream` — abort current AI stream
- `sendFollowUpQuestion` — follow-up within conversation
- `triggerAction` / `setToolbarVisible` — overlay toolbar: run a shortcut action, toggle the window
- `toolbar-cursor` — main → toolbar only: pointer position relative to the toolbar window (null when
  outside). The bar is click-through, so this is the only reliable source of hover input
- `start-transcription` / `stop-transcription` — speech transcription lifecycle
- `get-transcription-text` / `clear-transcription-text` — read/clear accumulated text

**Main → Renderer (send):**

- `sync-app-state` — push state changes (e.g., mouse ignore toggle)
- `screenshot-taken` / `screenshots-updated` — screenshot data
- `solution-clear` / `solution-chunk` / `solution-complete` / `solution-stopped` / `solution-error` — AI streaming lifecycle
- `interview-turn-start` / `interview-turn-end` / `interview-turns-clear` — interview transcript: one turn per question/answer. `solution-clear` no longer resets the transcript; only "新开对话" does
- `model-fallback` — a request moved to the backup model (`{ model, reason }`, reason is `timeout` | `error` | `empty`), shown as a toast
- `ai-loading-start` / `ai-loading-end` — loading state
- `scroll-page-up` / `scroll-page-down` — keyboard-driven scroll
- `toggle-transcription` — trigger start/stop transcription from shortcut
- `toggle-work-mode` — the toolbar asked to flip 笔试/面试; the renderer owns the setting and picks the next value
- `sync-toolbar-settings` — push toolbar-only settings (hover dwell, current work mode) into the toolbar window
- `transcription-text` / `transcription-error` / `transcription-stopped` / `transcription-cleared` — transcription events

### Zustand Stores

| Store                    | File                           | Persisted | Key State                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ------------------------ | ------------------------------ | --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `useSettingsStore`       | `lib/store/settings.ts`        | Yes (v6)  | `apiBaseURL`, `apiKey`, `model`, `customModels`, `fallbackModelEnabled`, `fallbackApiBaseURL`, `fallbackApiKey`, `fallbackModel`, `scenes` (prompt scenes), `activeSceneId`, `customPrompt` (derived from active scene), `opacity`, `showOverlayToolbar`, `toolbarHoverDelay`, `dashscopeApiKey`, `screenshotAutoSave`/`screenshotDir` (screenshot folder), `recordDir` (interview-log folder), `codeLanguage` (preferred code language) |
| `useShortcutsStore`      | `lib/store/shortcuts.ts`       | Yes (v5)  | `shortcuts` (action → key mapping with categories)                                                                                                                                                                                                                                                                                                                                                                                       |
| `useSolutionStore`       | `lib/store/solution.ts`        | No        | `isLoading`, `solutionChunks`, `screenshotData`, `errorMessage`                                                                                                                                                                                                                                                                                                                                                                          |
| `useInterviewTurnsStore` | `lib/store/interview-turns.ts` | No        | `turns` (interview Q&A transcript, last 10). Rules live as pure reducers in `src/shared/interview-turn.ts`; the store is deliberately outside React so a trip to settings does not drop the transcript. The same turns are also written to a Markdown log on disk — see Interview Record below                                                                                                                                           |
| `useTranscriptionStore`  | `lib/store/transcription.ts`   | No        | `isTranscribing`, `transcriptionText`, `errorMessage`                                                                                                                                                                                                                                                                                                                                                                                    |
| `useAppStore`            | `lib/store/app.ts`             | No        | `ignoreMouse`                                                                                                                                                                                                                                                                                                                                                                                                                            |

Settings are bidirectionally synced: renderer persists to localStorage, and on mount syncs to main process via `updateAppSettings()`. Main process `.env` values serve as initial defaults only.

## Key Patterns & Conventions

### Interview Record

Every interview turn is appended to a Markdown log, so a session can be reviewed
afterwards even though the on-screen transcript is memory-only:

- Path: `<documents>/interview/interview-YYYY-MM-DD-N.md` by default — one file
  per **run** of the app, numbered within the day (`-1`, `-2`, …) so a second
  run never appends to the first. Created on first write with a
  `# 面试记录 <date>` header. The folder is the `recordDir` setting (settings
  page → 保存面试记录), pushed into the main process by `setInterviewRecordDir`;
  blank means the default above. Names written before sessions were numbered
  (`interview-<date>.md`) are left alone and never counted.
- Closing the window asks what to call the file. `record-close-prompt.ts` holds
  the close with `event.preventDefault()`, the renderer puts up the dialog
  (`RecordSavePrompt`), and `renameInterviewRecord` moves the file that is
  already on disk to the chosen name. A rejected name (duplicate, unusable) keeps
  the dialog open with the session untouched, so another name or "取消" is always
  possible; "不保存" deletes the file; 20s of silence closes under the default
  name, because a window that refuses to close is worse than an unnamed file. A
  run that recorded no turn never asks and writes nothing.
- One block per turn: `## HH:MM:SS · <面试提问|手动追问|截图分析>`, the question as
  a `> ` quote, then the answer verbatim, plus `_知识库：…_` when the turn used
  knowledge-base documents. Stopped, errored and interrupted answers get an
  explicit warning line, so an incomplete answer never reads as a complete one.
- "新开对话" (which resets the transcript) writes a `## ——— 新开对话 HH:MM:SS ———`
  marker, so the log shows the same breaks the window does.
- Written by `src/main/interview-record.ts` at the same two choke points that
  broadcast `interview-turn-start` / `interview-turn-end`; the format is the pure
  `src/shared/interview-record.ts`, tested by `scripts/interview-record*.test.mjs`.
  Writes are queued (so two answers cannot interleave) and best-effort: a failure
  is logged and never disturbs a live interview.
- Only interview mode is recorded: it is the only mode with a transcript on
  screen, so `sendTurnStart` gates `beginRecordedTurn` on `settings.workMode`.
  A dual- or written-mode screenshot would otherwise land in the log with nothing
  to compare it against.
- Closing the app saves what is still open. The window's own close path settles
  the name first (above); this `before-quit` flush is what covers a quit with no
  window at all. `app.on('before-quit')` holds the
  quit for one `finalizeInterviewRecord()` (3s deadline), which writes any turn
  that never ended as `interrupted` with the text mirrored by
  `appendRecordedAnswer`, then waits for the queue to drain. The text is mirrored
  as it streams for exactly this reason — the on-screen transcript is memory-only,
  so a turn cut off by the app closing would otherwise be lost.
- Review log only — it is never read back into the prompt.

### Transcript Scrolling

The interview transcript keeps the newest answer in the middle of the window, so
a short answer is read where the eye already is instead of being pinned to the
last line at the bottom edge:

- The arithmetic is the pure `latestAnswerScrollTop` in
  `src/shared/latest-answer-scroll.ts` (tested by
  `scripts/latest-answer-scroll.test.mjs`); `coder/AppContent.tsx` supplies the
  measurements and applies the offset.
- An answer taller than the window cannot be centred without hiding its
  beginning, so it falls back to the previous behaviour: the newest text stays
  visible at the bottom while it streams.
- Following stops as soon as the user scrolls away from the anchored offset and
  resumes when they come back to it, so re-reading an earlier answer is not
  fought by the next chunk.
- Which turn counts as "newest" is tracked by turn id, not by list length: the
  transcript is capped at ten turns, so once the cap is reached a length check
  would never fire again.

### Model Failover

Each request may try a second endpoint when the preferred one fails. The rules
live in `src/shared/model-fallback.ts` (pure, tested without a network);
`src/main/ai.ts` supplies the AI SDK call and the timeout.

- Config: `fallbackModelEnabled` + `fallbackApiBaseURL` / `fallbackApiKey` /
  `fallbackModel` in the settings page. A blank base URL or key reuses the
  primary's, so the backup can be either another model on the same platform or a
  different platform entirely. A backup identical to the primary is dropped —
  retrying the same endpoint only adds waiting.
- Switching happens only **before the first chunk**: once text is on screen,
  failing over would either splice two answers together or make the visible
  answer vanish and restart, both worse than showing the error. A user-initiated
  stop never counts as a failure.
- Three things count as a failure: an error, no first chunk within
  `DEFAULT_FIRST_TOKEN_TIMEOUT_MS` (60s — an endpoint that is down usually
  does not fail fast, it simply never answers; and 20s was short enough to cut
  off a reasoning model that was still thinking), and a stream that closes
  without a single token. Each attempt gets its own
  `AbortController`, so a timed-out attempt is cancelled instead of left hanging.
- **The first-token timeout only applies when a backup exists.** With a single
  candidate `firstTokenTimeoutFor()` passes `null`, which disables the timer
  outright: with nothing to switch to, a timeout rescues nothing and can only
  kill a request that is still thinking.
- Every attempt shares the same first-token clock, including the backup: when
  both endpoints are wedged, an unbounded last attempt would leave the spinner
  running forever with no message at all. The setting is the lever for a slow
  primary, not an exemption for the backup.
- **AI SDK retries are disabled when a backup exists** (`maxRetries: 0`): the
  backup _is_ the retry, and the SDK's default two retries with backoff added
  roughly ten seconds before failing over. Without a backup the default is left
  alone, since it is the only resilience there is.
- The AI SDK ends a failed stream **silently, with zero chunks, when `onError`
  does not throw** — so `openAttempt` must keep its throwing `onError`, or
  failures become empty answers. `scripts/model-fallback-sdk.test.mjs` pins this
  contract against the real SDK and local stub endpoints.
- The renderer is told through `model-fallback` and shows a toast, so a
  degraded answer cannot be mistaken for a weak model.

### Window Stealth

The app is designed to be invisible to screen-sharing software:

- `BrowserWindow` options: `transparent: true`, `frame: false`, `skipTaskbar: true`
- `setContentProtection(true)` prevents screen capture of the window itself
- `setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true })`
- `keepWindowInFront()` repeatedly reasserts always-on-top for 5 seconds after show
- `showInactive()` on macOS/Windows to avoid stealing focus

### Overlay Toolbar

A second `BrowserWindow` (`src/main/toolbar-window.ts`) that renders the `/toolbar` route, so the shortcut actions can be driven with the pointer instead of the keyboard:

- Owns its own visibility state: the renderer calls `setToolbarVisible()` (main page + `showOverlayToolbar` setting), main additionally requires the main window to be visible. Never call `showInactive()` on it directly — go through `showToolbar()` / `hideToolbar()`.
- `focusable: false`, and permanently mouse-transparent
  (`setIgnoreMouseEvents(true, { forward: true })`). Windows answers `WM_SETCURSOR`
  from the window under the pointer, so a bar that accepted the mouse has to answer
  for itself and snaps the cursor back to an arrow — a tell on a shared screen, where
  the window is invisible but the cursor is not. **Clicks can never arrive**: anything
  click-only in the toolbar is dead code, and the resize handles had to go with them
  (no `pointerdown`, no drag). Hover therefore does not rely on forwarded
  `mousemove`: main samples `screen.getCursorScreenPoint()` every 100 ms while the
  bar is visible and pushes `toolbar-cursor` (relative to the window bounds, both in
  DIP); the renderer then hit-tests with `elementFromPoint`. `forward: true` stays
  on as a bonus source, merged into the same state machine.
- Opacity is applied at the window level to match the main window, which applies its own via `document.body.style.opacity`
- It is a separate renderer process, so its Zustand store is a **separate copy** that does not see changes made in the main window. Settings it needs must be pushed from main (`sync-toolbar-settings`), not read from the store.
- Buttons carry no `title`: native tooltips are drawn outside the window and are not covered by content protection
- `TOOLBAR_ACTIONS` (`lib/toolbar-actions.ts`) drives both the toolbar and its help page section; `triggerAction` is validated against `clickableActions` in `shortcuts.ts`
- The last button flips 笔试 ↔ 面试 (`toggleWorkMode`). Main only _asks_ — `toggle-work-mode` goes to the renderer, which computes the next value from its own store and syncs it back, so a fast double click cannot race. Icon and label come from `resolveToolbarAction(entry, workMode)`, fed by `sync-toolbar-settings` because the toolbar window cannot read the store. Dual mode needs no case: the toolbar is hidden there.

### Work Modes

`workMode` is one of `written` (screenshot-driven), `interview` (voice-driven, keeps
the on-screen transcript and the on-disk record) and `dual` (compact,
screenshot-only). Dual is a presentation, not a separate pipeline:

- `CoderPage` calls `setCompactMode()`, which parks the window in the corner of its
  display at 520x170. Resize handles are off there on purpose: the size is set
  programmatically and a drag would be overwritten.
- `.dual-mode` paints a translucent dark panel behind the answer, plus a slightly
  stronger strip behind the header. Both surfaces used to be fully transparent so
  the window would "blend into the page"; that left it with no opaque pixel of its
  own, so until an answer arrived — and whenever the page behind it happened to
  match the text colour — there was nothing on screen to see or aim at, and the
  user reported the window as gone. The text and icons there are light because the
  panel is dark; keep the two in step. It still obeys the `opacity` setting like
  every other mode.
- The overlay toolbar is hidden here (`showOverlayToolbar && workMode !== 'dual'`);
  the header carries its own screenshot button instead, and the answer is buffered
  and run through `formatDualAnswer` (`shared/dual-answer.ts`) as a single chunk.

### AI Integration

- All AI calls go through `src/main/ai.ts` using Vercel AI SDK's `streamText()`
- Provider: `@ai-sdk/openai` with custom `baseURL` (works with any OpenAI-compatible API)
- Model fallback: `Qwen/Qwen3-VL-32B-Instruct` for SiliconFlow, `gpt-5-mini` otherwise
- System prompts are maintained in the renderer settings store (`PRESET_SCENE_PROMPTS` in `lib/store/settings.ts`) as "prompt scenes"; the active scene's prompt is synced to the main process as `customPrompt`
- `codeLanguage` is injected as its own block right after `customPrompt`, so it outranks the default language written into the preset scenes. It applies to every mode that can answer with code (including `dual`) and is skipped entirely when blank; a question or interviewer naming a language still wins. See `src/shared/code-language.ts`
- Three streaming functions: `getSolutionStream` (first screenshot), `getFollowUpStream` (follow-up), `getGeneralStream` (multi-screenshot)
- Conversation history (`conversationMessages`) is maintained in `shortcuts.ts` as `ModelMessage[]`

### Stream Abort Pattern

- `StreamContext` with `AbortController` and `reason` (`'user'` | `'new-request'`)
- New requests automatically abort previous streams
- User can manually stop via shortcut or UI button
- Abort reason determines which IPC event to send (`solution-stopped` for user, silent for new-request)

### Real-time Speech Transcription

- Uses DashScope (Alibaba Cloud) Fun-ASR real-time ASR via WebSocket (`src/main/transcription.ts`)
- Requires a separate `dashscopeApiKey` configured in settings
- The quiet window before a final sentence is submitted as the question is user-adjustable:
  `interviewTriggerDelayMs` (a seconds field in the transcription settings card). The default
  (2000 ms), the bounds, and the ms<->s conversions live in `src/shared/interview-trigger.ts`
  (tested by `scripts/interview-trigger.test.mjs`); `src/main/transcription.ts` is the only
  consumer and exposes `setInterviewTriggerDelayMs`. It is sequential with the gateway's own
  `ASR_MAX_SENTENCE_SILENCE_MS` (800 ms), not competing with it, and a change applies to the next
  scheduled window -- a timer already counting down keeps the value it was created with.
- After a question is submitted, recognition output is ignored for
  `interviewTriggerMuteMs` (same card, default 3000 ms, `0` = off). One question
  frequently arrives as two sentences and the second one used to start a new
  request that aborted the answer that had just begun. This is a **timestamp
  check on incoming packets** (`resultMuteUntil` in `main/transcription.ts`), not
  a stop/restart: the socket and the audio capture keep running, so there is no
  reconnect to fail and nothing that can leave the app silently stopped. Note
  `0` is a legal value here, which is why the main process seeds this field with
  the real default instead of the `0 = not synced yet` sentinel used by the
  quiet-window delay.
- A question can be transcribed and still never be submitted, because arming the
  submission was tied to a single timer that any incoming packet could cancel.
  The concrete trap: the gateway emits an **empty `sentence_begin` marker** when
  it opens a sentence, the handler cleared the armed timer for it and no final
  ever followed, so the text sat on screen forever ("问完了还一直在等"). Two
  fixes: only a packet with **actual text** cancels the quiet window, and a
  500 ms watchdog re-arms the submission when text is buffered, quiet has
  passed, and nothing is scheduled. The decision lives in
  `shouldRearmTrigger` (`src/shared/interview-trigger.ts`) so it is unit-tested
  rather than re-derived in the handler. Breadcrumbs are written to
  `<userData>/asr.log` (`submit` / `skip:*` / `watchdog:rearm`) — read that file
  first when a report says the app "just waited".
- Audio is captured in the renderer via `getDisplayMedia()` (system audio), downsampled to 16kHz PCM, and streamed to main process via IPC
- `TranscriptionBar` is absolute-positioned at the top of the coder page, shows up to 3 lines with auto-scroll
- On screenshot (`takeScreenshot` / `appendScreenshot`), accumulated transcription text is automatically attached to the AI prompt, then cleared
- `clearTranscription` shortcut clears text without submitting to AI
- Transcription shortcuts are disabled in settings UI when `dashscopeApiKey` is not configured

### Shortcut System

- Global shortcuts registered via Electron's `globalShortcut` API
- Renderer stores shortcut config in Zustand (persisted); sends to main on init
- On Windows, `Alt`-based shortcuts also register `Ctrl+Alt` variant for compatibility
- Shortcut actions are string-keyed callbacks in `shortcuts.ts`
- Default shortcuts use `platformAlt` (`Alt` on macOS, `CommandOrControl` on Windows/Linux)

### UI Component Patterns

- shadcn/ui components in `src/renderer/src/components/ui/` — do NOT edit these directly, use the shadcn CLI to add/update
- `cn()` utility (clsx + tailwind-merge) for conditional class merging
- `getCloneableFields()` strips functions from store state before sending over IPC
- Platform-aware shortcut display via `ShortcutRenderer` (⌘, ⌥, ⇧ on Mac; Ctrl, Alt, Shift on Windows)

## Development

### Commands

```bash
npm install          # Install dependencies
npm run dev          # Start in dev mode (electron-vite dev)
npm run build        # Typecheck + build (electron-vite build)
npm run build:mac    # Build macOS distributable
npm run build:win    # Build Windows distributable
npm run typecheck    # Run TypeScript type checking (node + web)
npm run lint         # ESLint over the whole repo (src/ **and** scripts/)
npm run format       # Run Prettier
```

### Configuration

The `.env` file at project root configures the AI provider:

```env
API_BASE_URL="https://openrouter.ai/api/v1"  # OpenAI-compatible API endpoint
API_KEY="sk-..."                               # API key
MODEL="gpt-5-mini"                             # Optional: override default model
```

These are read by dotenv in the main process and merged with renderer-side settings (renderer settings take priority when set).

### Path Aliases

- `@renderer/*` and `@/*` both resolve to `src/renderer/src/*`
- Configured in `tsconfig.web.json` and `electron.vite.config.ts`

### Code Style

- Prettier: single quotes, no semicolons, 100 char print width, no trailing commas
- ESLint: TypeScript + React + React Hooks + React Refresh rules
- UI text and user-facing strings are in **Chinese** (中文)
- Code comments and variable names are in **English**

## Important Notes for AI Agents

1. **Three TypeScript configs**: `tsconfig.node.json` (main + preload), `tsconfig.web.json` (renderer). The root `tsconfig.json` is a project references file only.

2. **System prompts live in the renderer**: All preset scene prompts are defined in `src/renderer/src/lib/store/settings.ts` (`PRESET_SCENE_PROMPTS`). The main process only consumes the synced `customPrompt` and has no built-in prompt of its own.

3. **`global.mainWindow`**: The main window reference is stored as a global variable, declared in `src/main/index.d.ts`.

4. **Settings flow**: `.env` → main process `settings` object → renderer reads on mount via IPC → renderer persists to localStorage via Zustand. Renderer-side changes are sent back to main via `updateAppSettings`.

5. **No shared types directory**: Main process types (`AppSettings`, `AppState`) are imported directly by the preload script from `../main/settings` and `../main/state`. This works because preload shares the Node.js tsconfig.

6. **Streaming orchestration is in `shortcuts.ts`**: Despite the filename, this 580+ line file is the central orchestrator for both global shortcuts AND AI streaming logic. It manages conversation history, abort controllers, and IPC communication for the entire AI workflow.

7. **Window movement**: The window can be moved via keyboard shortcuts in 200px steps (up/down/left/right).

8. **macOS auto-update is disabled**: `publish: null` in electron-builder.yml for mac target. Auto-update only works on Windows.
