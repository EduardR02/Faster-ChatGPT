# Sidekick LLM

Chrome extension that gives you a side panel for talking to LLMs. Supports Claude, GPT, Gemini, DeepSeek, Grok, Mistral, Kimi, and local models. Connect a ChatGPT subscription for OpenAI chat or use provider API keys directly — nothing goes through an intermediary.

**[Chrome Web Store](https://chromewebstore.google.com/detail/sidekick-llm/nlpcdeggdeeopcpeeopbjmmkeahojaod)**

![Basic chat example](images/Start_Panel.PNG)

## Why

Started as a text selection thing — hold Ctrl, select text, get an answer in the side panel. But now I mostly just use it as a chat window. Having an LLM in your side panel is really convenient, it's always there, you can browse and see responses at the same time, and it opens instantly. Nowadays it's like 99% chat and 1% selection for me.

Essentially the point is that it's a centralized LLM hub, history all in one place, insanely convenient, and you can pick any model at any point in time.

## Features

### Multi-model

All providers in one place. Switch models mid-conversation. Regenerate a response with a different model. Add new models from settings whenever.

Defaults apply only to fresh installs. Extension updates leave your saved model list unchanged; add new models manually in Settings. The current additions are OpenAI `gpt-6-sol` and `gpt-6-luna`, and Anthropic `claude-opus-5-5`. OpenAI models support either an API key or a connected ChatGPT subscription, subject to your account's model access.

### Council Mode

Send your prompt to multiple models at once. An arbiter reads all the responses and writes a final synthesis.

### Arena Mode

Blind side-by-side comparison, like LMSYS but personal. Two random models, you vote which is better, Elo ratings track over time. Because it's fun, and because LMSYS has been questionable.

![Arena mode example](images/strawberry_arena.PNG)
![Arena mode resolved](images/Arena_resolved.PNG)

### History & Search

All chats saved locally in IndexedDB. Full-text search that highlights matches. Chats get auto-titled by an LLM in the background; a title finishing after you switch chats updates only its original chat. You can branch off from any message to start a new conversation while keeping a link to the original.

### Reasoning continuity

OpenAI, Claude, Gemini, and Grok keep their native encrypted reasoning locally, alongside the readable answer. Gemini preserves original signed content parts, including generated images; Grok uses the Responses API. Kimi K3 retains its returned `reasoning_content`, and supported Mistral models retain their ordered thinking chunks. Streaming and non-streaming responses preserve the same replay state, including signed thinking with no visible text.

Native replay uses conservative exact-provider/model and credential/account checks, plus unchanged preceding context and visible response content. Switching providers, models, or API keys keeps the visible conversation but omits incompatible native reasoning without deleting its saved copy. Refreshing a ChatGPT access token keeps the same account scope. Edited earlier context and merged thinking-loop responses cannot reuse reasoning bound to the original request.

Saved chats and JSON backups retain native state through restoration, branches, regeneration, Arena, and Council. Council synthesis receives visible expert answers, not their private reasoning. Markdown exports and search do not expose opaque payloads. Restored chats can reuse compatible reasoning without expiring server-side response IDs; no client-side expiry is imposed, but providers do not guarantee indefinite validity. Older chats cannot recover native state discarded before this feature.

Completed OpenAI/Grok responses retain recoverable failed tool calls. Claude search results and citations are retained even without thinking, and Mistral retains reference chunks inside thinking. If every Council expert fails, synthesis is skipped instead of saving a collector answer without expert input.

DeepSeek resends known same-model reasoning as `reasoning_content`; its API ignores it on requests without tools. Kimi K3 also accepts older reasoning with known same-model provenance, never unknown or foreign traces. Local llama.cpp reasoning replay requires the server's `supports_preserve_reasoning` capability and a matching endpoint, loaded model, and chat template, checked before each request. Named local router selections retain the selected model ID rather than substituting the first advertised model. OpenAI's model default selects current-turn or all-turn reasoning behavior.

Mistral Small's reasoning control offers `none` and `high`; models without documented adjustable reasoning keep their existing behavior. Gemini 2.5 Flash's off control disables its thinking budget. Claude manual thinking rejects output caps too small for the minimum thinking budget instead of exceeding the configured cap.

Stream errors, premature EOF, and token-limit truncation are errors, not successful saved answers. Kimi and DeepSeek additionally require the final `[DONE]` marker. Partial text can remain visible, but incomplete native responses are not replayed as complete reasoning.

### Token accounting

All providers report cumulative usage snapshots rather than additive stream deltas. Input excludes cached reads and includes cache writes; cached reads are counted separately, and reported cache writes are tracked as a subset of input. Claude input combines ordinary input and cache creation, keeping cache reads separate.

Message footers and the popup's lifetime totals show `input | output | N cached` when cached reads are nonzero. Tooltips expose reported cache writes without adding them to input a second time. Existing lifetime input/output totals are preserved; historical cached usage cannot be reconstructed, so separate lifetime cache totals accumulate from newly recorded usage.

### Rendering

LaTeX/math (Temml), syntax-highlighted code blocks with copy button, streaming markdown that doesn't flicker. OpenAI refusals are visible, and OpenAI/Claude search citations appear as clickable source markers after the answer without changing the retained native payload.

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
- **Images & files** — drag and drop or paste, multiple per message; DeepSeek V4.1 Flash supports image input
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
4. Extension popup → Settings → connect ChatGPT and/or add provider API keys

## Security

Your API keys and ChatGPT OAuth tokens stay in `chrome.storage.local` and go straight to the selected provider. ChatGPT subscription authentication opens OpenAI's Codex account-approval page; while connected, OpenAI chat uses the subscription endpoint, while transcription still requires an API key. No third-party server is involved. Credentials are visible to extension code and browser developer tools.


## Future 

This just becomes a "Jarvis" computer use agent that can deploy subagents for anything. At some point you're just building what everone else is building (see claude chrome extension), but the difference is that you're not provider locked.