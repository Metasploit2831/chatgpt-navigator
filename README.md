# ChatGPT Navigator

A Chrome extension that turns ChatGPT conversations into a compact, searchable sidebar.

## Features

- Prompt and answer outline grouped by conversation turn
- Toggle between outline view and a visual mind map
- Click any item to jump back to that message
- Search across indexed prompts and answers
- Optional Chrome built-in AI labels for every message
- Clean overlay UI with keyboard focus states
- No backend, tracking, or external dependencies

## Install Locally

1. Open Chrome and go to `chrome://extensions`.
2. Enable `Developer mode`.
3. Select `Load unpacked`.
4. Choose this repository folder.
5. Open `https://chatgpt.com` or `https://chat.openai.com`.

## How It Works

```text
ChatGPT DOM
  -> Extract user and assistant messages
  -> Create fast rule-based labels
  -> Try Chrome built-in AI labels for every message
  -> Group assistant answers under the nearest prompt
  -> Render a searchable outline or mind map
  -> Scroll to messages on click
```

## Files

- `manifest.json` defines the MV3 extension and ChatGPT URL matches.
- `content.js` extracts messages, builds the outline, and injects controls.
- `styles.css` styles the navigator overlay.

## Notes

ChatGPT DOM structure can change. If messages stop appearing, update `ROLE_SELECTOR` or `TURN_SELECTOR` in `content.js`.

Chrome built-in AI labels require a supported Chrome desktop build and Gemini Nano availability. If unavailable, Navigator automatically keeps the rule-based labels.
