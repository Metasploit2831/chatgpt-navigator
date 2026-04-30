# ChatGPT Navigator Solution Notes

## Problem

The extension loaded in Chrome, but the Navigator panel showed `0` messages even when the open ChatGPT conversation had many messages.

There were also prototype issues in the original implementation:

- Message rendering used `innerHTML`, which was unsafe for user-provided chat text.
- The tree structure was generated with fake index-based grouping.
- The extension only looked for one ChatGPT DOM selector.
- Refresh used polling without robust DOM-change handling.
- The UI was functional but visually rough.
- The manifest requested permissions that were not needed.
- The README had an unfinished code block and lacked install instructions.

## Root Cause

ChatGPT changes its DOM over time. The original code only searched for:

```js
[data-message-author-role="user"]
```

That meant it only found user messages, and if ChatGPT changed or delayed that markup, the extension found nothing.

The improved code now uses two selector strategies:

```js
const ROLE_SELECTOR = '[data-message-author-role="user"], [data-message-author-role="assistant"]';
const TURN_SELECTOR = [
  '[data-testid^="conversation-turn-"]',
  'article',
  'main [class*="group/conversation-turn"]'
].join(",");
```

First it looks for explicit user/assistant role nodes. If those are missing, it falls back to broader conversation-turn containers.

## Code Changes

### Safer Message Extraction

Changed message extraction to:

- collect both user and assistant messages
- ignore Navigator's own injected DOM
- use `innerText` with `textContent` fallback
- infer role when explicit role attributes are missing
- filter empty messages
- create fast rule-based labels immediately
- optionally replace labels with Chrome built-in AI summaries for every message

Key functions added or changed:

- `getMessageText`
- `uniqueElements`
- `isNavigatorElement`
- `inferRole`
- `getMessageElements`
- `getMessages`
- `getLabel`
- `queueAiLabel`
- `summarizeLabel`

### Optional Chrome Built-in AI Labels

Every non-empty message now tries Chrome's built-in `Summarizer` API when available. Navigator:

1. renders a rule-based label immediately
2. queues a local Chrome AI summary
3. updates the row when the AI label is ready
4. falls back to the rule label if Chrome AI is unavailable

This keeps the extension reliable while giving better labels on supported Chrome desktop setups.

### Real Conversation Outline

The old `buildTree` grouped messages using modulo math. That did not represent the actual chat.

The new `buildOutline` groups assistant answers under the nearest user prompt:

```text
Prompt
  Answer
Prompt
  Answer
```

This is simpler and more accurate for a linear ChatGPT conversation.

### Safe DOM Rendering

Removed dynamic `innerHTML` rendering for chat text.

The new renderer uses:

- `document.createElement`
- `textContent`
- `title`
- `append`
- event listeners

This avoids injecting untrusted chat content as HTML.

### Better Refresh Handling

Added a debounced `MutationObserver` so the Navigator updates when ChatGPT loads or changes messages.

Also fixed a render loop issue by disconnecting the observer during Navigator DOM updates, then reconnecting it after render.

### Collapse State

Added persisted collapse state using:

```js
localStorage.setItem("chatgptNavigatorCollapsed", String(collapsed));
```

The bottom-right button now toggles the panel and remembers the state.

## UI Changes

The UI was rebuilt with a cleaner dark overlay style:

- compact right-side panel
- prompt/answer role markers
- small `AI` badge when Chrome built-in AI produced the label
- SVG icons instead of text/emoji controls
- accessible icon buttons with `aria-label`
- visible keyboard focus states
- 44px control targets
- mobile responsive width
- reduced-motion support
- clearer empty state

The panel now shows:

- total indexed message count
- refresh button
- search field
- prompt rows
- nested answer rows

## Manifest Changes

Removed unused permissions:

```json
"permissions": ["activeTab", "scripting"]
```

The extension is loaded as a static content script, so those permissions are not required.

## README Changes

Updated the README with:

- local Chrome install steps
- file descriptions
- simplified feature list
- note about updating selectors if ChatGPT changes its DOM

## How To Test

1. Open Chrome.
2. Go to `chrome://extensions`.
3. Enable `Developer mode`.
4. Click `Load unpacked`.
5. Select this repository folder.
6. Open `https://chatgpt.com`.
7. Open an actual chat thread.
8. Refresh the ChatGPT tab.
9. If needed, click the Navigator refresh icon.

Expected result:

- Navigator appears on the right.
- Message count is greater than `0` for a loaded chat.
- Prompt and answer rows appear.
- Clicking a row scrolls to that message.
- Search filters matching prompts and answers.
- Toggle button collapses and restores the panel.

## Verification

The following checks passed:

```bash
rtk node --check content.js
rtk node -e "JSON.parse(require('fs').readFileSync('manifest.json','utf8')); console.log('manifest ok')"
```

Also scanned for unsafe or stale patterns:

```bash
rtk rg -n "innerHTML|permissions|chatgpt-sidebar|toggle-btn" content.js styles.css manifest.json README.md
```

No unsafe `innerHTML`, unused permissions, or old injected IDs remained.

## Important Note

Navigator indexes messages inside the currently open ChatGPT conversation. It does not index the left sidebar list of previous conversations.
