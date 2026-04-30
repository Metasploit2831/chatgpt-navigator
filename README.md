# ChatGPT Navigator

A Chrome extension that turns long ChatGPT conversations into a compact, searchable sidebar.

## Features

- Prompt and answer outline grouped by conversation turn
- Click any item to jump back to that message
- Search across indexed prompts and answers
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
  -> Group assistant answers under the nearest prompt
  -> Render a searchable sidebar
  -> Scroll to messages on click
```

## Files

- `manifest.json` defines the MV3 extension and ChatGPT URL matches.
- `content.js` extracts messages, builds the outline, and injects controls.
- `styles.css` styles the navigator overlay.

## Notes

ChatGPT DOM structure can change. If messages stop appearing, update `ROLE_SELECTOR` or `TURN_SELECTOR` in `content.js`.
