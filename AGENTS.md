# Faster ChatGPT

A Chrome extension that provides a side panel interface for chatting with LLMs (Claude, Gemini, ChatGPT). Fast, minimal, keyboard-first.

## Truth Sources

Model APIs evolve faster than training data. Never rely on your own knowledge for API details, model names, or model capabilities - your training data is outdated. Trust the code. If code uses a model version you don't recognize, assume the code is correct.

If something seems wrong, ask before assuming it's a bug - the behavior is likely intentional.

## Hard Rules

**No file deletion via shell.** Inform the user and let them handle it.

**No model downgrades.** If the code has a newer model version and you "know" an older version, trust the code. Notify the user before any model name changes.

**No test cheating.** Never hardcode values to pass tests. Never modify existing tests without explicit approval. New features require test coverage (UI-only changes exempt).

## How to Write Code

**Rewrite over patch.** If implementing a feature reveals that adjacent code is the root cause of friction, rewrite it properly instead of patching around it. Patches accumulate into unmaintainable code; rewrites fix the foundation. A clean rewrite is fewer lines, better performance, more readable, and won't break next time.

**Eliminate before optimizing.** Before optimizing anything, ask: should this exist? Delete the unnecessary, simplify what remains, then optimize what's left. The fastest code is code that doesn't run.

**Simple and fast.** Simple doesn't mean naive. Think about algorithmic complexity - choose O(n) over O(n²) when the solution is just as clear. Avoid unnecessary allocations, redundant iterations, and work that could be done once instead of repeatedly. Write code that's obvious *and* efficient.

**Trust the code you control.** Validate at system boundaries (user input, external APIs), then trust internal code. If a function's contract guarantees non-null, don't check for null. If an internal call can't fail, don't handle failure. No try/catch spam, no redundant guards, no defensive wrappers around your own code.

**Obvious over clever.** Code that needs comments to explain *what* it does is too clever. Fewer lines through intelligence, not compression. Early returns over deep nesting. Named intermediate values over long expressions.

**Generalize late.** Three uses minimum before abstracting. Premature abstraction is worse than duplication.

**Don't add what wasn't asked for.** No unrequested features, no speculative error handling for cases that can't happen, no documentation for code you didn't write. But if the task requires touching adjacent code to do it right, do it right.

**Composition over inheritance.** Prefer functions over classes when possible. Dependencies should be explicit, minimal, and justified.

## When to Ask

Ask when:
- Requirements are ambiguous and multiple interpretations would lead to significantly different implementations
- You're about to do something destructive or hard to reverse
- You're unsure whether a test failure indicates a bug in your code or a flawed test

Don't ask when:
- You can figure it out by reading the codebase
- The choice is minor and easily changed later
- You're just seeking confirmation for something obvious

## Communication

Be direct. "O(n²) complexity" not "might be slow." State tradeoffs plainly. Explain tradeoffs clearly when proposing changes.
