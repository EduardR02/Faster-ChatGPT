# Sidekick LLM

Chrome extension that gives you a side panel for talking to LLMs. Supports Claude, GPT, Gemini, DeepSeek, Grok, Mistral, Kimi, and local models. Uses your API keys directly — nothing goes through me.

**[Chrome Web Store](https://chromewebstore.google.com/detail/sidekick-llm/nlpcdeggdeeopcpeeopbjmmkeahojaod)**

![Basic chat example](images/Start_Panel.PNG)

## Why

Started as a text selection thing — hold Ctrl, select text, get an answer in the side panel. But now I mostly just use it as a chat window. Having an LLM in your side panel is really convenient, it's always there, you can browse and see responses at the same time, and it opens instantly. Nowadays it's like 99% chat and 1% selection for me.

Essentially the point is that it's a centralized LLM hub, history all in one place, insanely convenient, and you can pick any model at any point in time.

## Features

### Multi-model

All providers in one place. Switch models mid-conversation. Regenerate a response with a different model. Add new models from settings whenever.

### Council Mode

Send your prompt to multiple models at once. An arbiter reads all the responses and writes a final synthesis.

### Arena Mode

Blind side-by-side comparison, like LMSYS but personal. Two random models, you vote which is better, Elo ratings track over time. Because it's fun, and because LMSYS has been questionable.

![Arena mode example](images/strawberry_arena.PNG)
![Arena mode resolved](images/Arena_resolved.PNG)

### History & Search

All chats saved locally in IndexedDB. Full-text search that highlights matches. Chats get auto-titled by an LLM in the background. You can branch off from any message to start a new conversation while keeping a link to the original.

### Rendering

LaTeX/math (Temml), syntax-highlighted code blocks with copy button, streaming markdown that doesn't flicker.

### Keyboard Shortcuts

| Shortcut | Mac | Action |
|---|---|---|
| `Ctrl+Shift+L` | `Cmd+Shift+K` | New chat |
| `Ctrl+Shift+H` | `Cmd+Shift+H` | Open history |
| `Ctrl` + select text | `Cmd` + select text | Side panel with selection |
| `Enter` | | Send |
| `Shift+Enter` | | New line |

### Other features

- **Multi-tab** — multiple chat sessions open at once
- **Images & files** — drag and drop or paste, multiple per message
- **Image generation** — supports Nano Banana models
- **Voice input** — record and transcribe (Mistral)
- **Web search** — toggle for supported models
- **Incognito mode** — nothing saved, toggle mid-conversation
- **Thinking mode** — model reflects in a loop before answering
- **Token counter** — see input/output tokens per response
- **Pop-out** — move between side panel and full tab
- **Custom prompts & temperature** — set your own system prompt, tweak sampling
- **Instant prompts** — select text, get answer, zero extra input

![Instant prompt example](images/InstantPrompt.PNG)

## Installation

**Chrome Web Store**: [install here](https://chromewebstore.google.com/detail/sidekick-llm/nlpcdeggdeeopcpeeopbjmmkeahojaod)

**Manual:**
1. Download this repo as ZIP, unzip somewhere permanent
2. `chrome://extensions` → enable Developer Mode
3. Load Unpacked → select the folder
4. Extension popup → Settings → add API keys

## Security

Your API keys stay local and go straight to provider APIs. No third-party server involved, ever. That said, keys are visible in browser dev tools (Network tab, JS runtime). If that bothers you, use keys with limited credits.


## Future 

This just becomes a "Jarvis" computer use agent that can deploy subagents for anything. At some point you're just building what everone else is building (see claude chrome extension), but the difference is that you're not provider locked.