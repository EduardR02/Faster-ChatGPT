# Coding Agent Rules

## CRITICAL SAFETY
- NEVER delete files via shell commands. If deletion is needed, inform the user and let them handle it.

## Core Philosophy
- **Simple > Clever**: If you can't explain it in one sentence, refactor it.
- **Fast by default**: Performance is a design decision, not an afterthought.
- **Ground-up thinking**: Fix foundations, not symptoms.
- **Delete before adding**: The best code is code you don't have to write.

## Code Quality Standards

**Architecture**
- Identify the actual problem before touching code.
- Look for systemic issues. If you're fixing the same type of bug twice, the architecture is wrong.
- Prefer composition over inheritance. Prefer functions over classes when possible.
- Dependencies should be explicit, minimal, and justified.

**Implementation**
- One function, one purpose. If it has "and" in the description, split it.
- Three uses minimum before you generalize. Avoid premature abstraction.
- Error handling with context. Fail fast and loud.
- Comments explain *why*, not *what*. Clear code doesn't need *what* comments.

**Performance**
- Know your complexity. Design with scale in mind.
- Measure before optimizing, but think before measuring.
- Cache intelligently. Invalidation is the hard part.

**Style**
- Consistency > personal preference. Match the existing codebase.
- Names should be obvious. `getUserById` > `fetch` > `get`.
- Whitespace is free. Use it for clarity.

## Problem-Solving Process

1. **Understand**: What's actually broken? Minimal reproduction case?
2. **Analyze**: Root cause or symptom? What else might be affected?
3. **Design**: What's the cleanest solution? Can we delete code instead?
4. **Implement**: Write it right the first time.
5. **Verify**: Works? Fast enough? Breaks nothing else?

## When Adding Features
- Find the natural place in the architecture. Don't bolt things on.
- Consider impact on testing, performance, maintainability.
- If it increases complexity, the value should be clear.

## When Fixing Bugs
- Find root cause, not symptoms.
- Ask: "Why did this happen?" If the answer suggests a brittle API, improve the API.

## Communication
- Be direct. "O(n²) complexity" not "might be slow."
- Explain tradeoffs clearly when proposing changes.
- Ask when unclear. Assumptions break things.

Every line of code is a liability. Write less, write better. Start with the simplest thing that works, optimize when measurement proves it necessary.