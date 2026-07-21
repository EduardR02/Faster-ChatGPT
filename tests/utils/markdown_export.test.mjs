import { describe, expect, test } from 'bun:test';
import { serializeChatToMarkdown } from '../../src/js/markdown_export.js';

describe('serializeChatToMarkdown', () => {
    test('serializes a basic user/assistant conversation with title and model label', () => {
        const chat = {
            title: 'Greeting chat',
            messages: [
                { role: 'user', contents: [[{ type: 'text', content: 'Hello there' }]] },
                { role: 'assistant', contents: [[{ type: 'text', content: 'Hi! How can I help?', model: 'gpt-5.2' }]] }
            ]
        };

        expect(serializeChatToMarkdown(chat)).toBe(
            '# Greeting chat\n' +
            '\n' +
            '**You:**\n' +
            '\n' +
            'Hello there\n' +
            '\n' +
            '**Assistant (gpt-5.2):**\n' +
            '\n' +
            'Hi! How can I help?\n'
        );
    });

    test('falls back to untitled heading and handles empty chats', () => {
        expect(serializeChatToMarkdown({ title: '', messages: [] })).toBe('# Untitled chat\n');
        expect(serializeChatToMarkdown({ title: '  ', messages: [] })).toBe('# Untitled chat\n');
        expect(serializeChatToMarkdown({})).toBe('# Untitled chat\n');
        expect(serializeChatToMarkdown({ title: 'Empty', messages: [] })).toBe('# Empty\n');
    });

    test('serializes system messages', () => {
        const chat = {
            title: 'System',
            messages: [
                { role: 'system', contents: [[{ type: 'text', content: 'You are helpful.' }]] },
                { role: 'user', contents: [[{ type: 'text', content: 'Hi' }]] }
            ]
        };

        expect(serializeChatToMarkdown(chat)).toBe(
            '# System\n' +
            '\n' +
            '**System:**\n' +
            '\n' +
            'You are helpful.\n' +
            '\n' +
            '**You:**\n' +
            '\n' +
            'Hi\n'
        );
    });

    test('omits model label when no part carries one', () => {
        const chat = {
            title: 'Plain',
            messages: [
                { role: 'assistant', contents: [[{ type: 'text', content: 'No model here' }]] }
            ]
        };

        expect(serializeChatToMarkdown(chat)).toContain('**Assistant:**\n\nNo model here');
    });

    test('renders thought parts as labeled blockquotes with multi-line support', () => {
        const chat = {
            title: 'Thinking',
            messages: [
                { role: 'user', contents: [[{ type: 'text', content: 'Hard question' }]] },
                {
                    role: 'assistant',
                    contents: [[
                        { type: 'thought', content: 'first line\n\nsecond line', model: 'claude-opus-4.7' },
                        { type: 'text', content: 'The answer.', model: 'claude-opus-4.7' }
                    ]]
                }
            ]
        };

        expect(serializeChatToMarkdown(chat)).toBe(
            '# Thinking\n' +
            '\n' +
            '**You:**\n' +
            '\n' +
            'Hard question\n' +
            '\n' +
            '**Assistant (claude-opus-4.7):**\n' +
            '\n' +
            '> *Thinking:*\n' +
            '> first line\n' +
            '>\n' +
            '> second line\n' +
            '\n' +
            'The answer.\n'
        );
    });

    test('serializes regenerations with arrow marker and per-regeneration model', () => {
        const chat = {
            title: 'Regen',
            messages: [
                { role: 'user', contents: [[{ type: 'text', content: 'Explain X' }]] },
                {
                    role: 'assistant',
                    contents: [
                        [{ type: 'text', content: 'First attempt', model: 'gpt-5.2' }],
                        [{ type: 'text', content: 'Second attempt', model: 'gpt-5.1' }]
                    ]
                }
            ]
        };

        expect(serializeChatToMarkdown(chat)).toBe(
            '# Regen\n' +
            '\n' +
            '**You:**\n' +
            '\n' +
            'Explain X\n' +
            '\n' +
            '**Assistant (gpt-5.2):**\n' +
            '\n' +
            'First attempt\n' +
            '\n' +
            '**Assistant (gpt-5.1) ⟳:**\n' +
            '\n' +
            'Second attempt\n'
        );
    });

    test('skips empty parts and empty regeneration groups', () => {
        const chat = {
            title: 'Empties',
            messages: [
                { role: 'user', contents: [[{ type: 'text', content: '' }]] },
                {
                    role: 'assistant',
                    contents: [
                        [],
                        [{ type: 'text', content: '', model: 'gpt-5.2' }],
                        [{ type: 'text', content: 'Real answer', model: 'gpt-5.2' }]
                    ]
                }
            ]
        };

        expect(serializeChatToMarkdown(chat)).toBe(
            '# Empties\n' +
            '\n' +
            '**Assistant (gpt-5.2) ⟳:**\n' +
            '\n' +
            'Real answer\n'
        );
    });

    test('serializes user message media as placeholders before text', () => {
        const chat = {
            title: 'Media',
            messages: [
                {
                    role: 'user',
                    contents: [[{ type: 'text', content: 'check these' }]],
                    images: ['abc123blobhash', 'data:image/png;base64,xxx'],
                    files: [{ name: 'notes.txt', content: 'file body' }, { name: '', content: 'x' }],
                    audio: [{ name: 'voice.mp3', data: 'data:audio/mp3;base64,AAA' }, 'data:audio/wav;base64,BBB']
                }
            ]
        };

        expect(serializeChatToMarkdown(chat)).toBe(
            '# Media\n' +
            '\n' +
            '**You:**\n' +
            '\n' +
            '*[Image]*\n' +
            '*[Image]*\n' +
            '*[File: notes.txt]*\n' +
            '*[File]*\n' +
            '*[Audio: voice.mp3]*\n' +
            '*[Audio]*\n' +
            '\n' +
            'check these\n'
        );
    });

    test('serializes media-only user messages without text part', () => {
        const chat = {
            title: 'Image only',
            messages: [
                {
                    role: 'user',
                    contents: [[{ type: 'text', content: '' }]],
                    images: ['blobhash']
                }
            ]
        };

        expect(serializeChatToMarkdown(chat)).toBe(
            '# Image only\n' +
            '\n' +
            '**You:**\n' +
            '\n' +
            '*[Image]*\n'
        );
    });

    test('serializes assistant inline image and audio parts as placeholders', () => {
        const chat = {
            title: 'Generated media',
            messages: [
                {
                    role: 'assistant',
                    contents: [[
                        { type: 'text', content: 'Here you go:', model: 'gemini-3-pro-image' },
                        { type: 'image', content: 'deadbeefblobhash' },
                        { type: 'audio', content: 'data:audio/mp3;base64,CC' }
                    ]]
                }
            ]
        };

        expect(serializeChatToMarkdown(chat)).toBe(
            '# Generated media\n' +
            '\n' +
            '**Assistant (gemini-3-pro-image):**\n' +
            '\n' +
            'Here you go:\n' +
            '\n' +
            '*[Image]*\n' +
            '\n' +
            '*[Audio]*\n'
        );
    });

    test('recovers model label from earlier parts when the last part has none', () => {
        const chat = {
            title: 'Label scan',
            messages: [
                {
                    role: 'assistant',
                    contents: [[
                        { type: 'text', content: 'Caption', model: 'gpt-image-2' },
                        { type: 'image', content: 'hash' }
                    ]]
                }
            ]
        };

        expect(serializeChatToMarkdown(chat)).toContain('**Assistant (gpt-image-2):**');
    });

    test('joins multiple text parts in one group as paragraphs', () => {
        const chat = {
            title: 'Multi',
            messages: [
                {
                    role: 'assistant',
                    contents: [[
                        { type: 'text', content: 'part one', model: 'm' },
                        { type: 'text', content: 'part two', model: 'm' }
                    ]]
                }
            ]
        };

        expect(serializeChatToMarkdown(chat)).toContain('part one\n\npart two');
    });

    test('serializes arena branches, regenerations, winner and continuation', () => {
        const chat = {
            title: 'Arena chat',
            messages: [
                { role: 'user', contents: [[{ type: 'text', content: 'Pick the best' }]] },
                {
                    role: 'assistant',
                    choice: 'model_a',
                    continued_with: 'model_a',
                    responses: {
                        model_a: {
                            name: 'gpt-5.2',
                            messages: [
                                [{ type: 'text', content: 'Answer A1' }],
                                [
                                    { type: 'thought', content: 'rethinking' },
                                    { type: 'text', content: 'Answer A2' }
                                ]
                            ]
                        },
                        model_b: {
                            name: 'claude-opus-4.7',
                            messages: [
                                [{ type: 'text', content: 'Answer B1' }]
                            ]
                        }
                    }
                }
            ]
        };

        expect(serializeChatToMarkdown(chat)).toBe(
            '# Arena chat\n' +
            '\n' +
            '**You:**\n' +
            '\n' +
            'Pick the best\n' +
            '\n' +
            '**Arena:**\n' +
            '\n' +
            '**Model A (gpt-5.2):**\n' +
            '\n' +
            'Answer A1\n' +
            '\n' +
            '**Model A (gpt-5.2) ⟳:**\n' +
            '\n' +
            '> *Thinking:*\n' +
            '> rethinking\n' +
            '\n' +
            'Answer A2\n' +
            '\n' +
            '**Model B (claude-opus-4.7):**\n' +
            '\n' +
            'Answer B1\n' +
            '\n' +
            '*Winner: Model A (gpt-5.2)*\n' +
            '\n' +
            '*Continued with Model A (gpt-5.2)*\n'
        );
    });

    test('serializes arena draw, both-bad and unknown choice results', () => {
        const makeArena = (choice) => ({
            title: 'Arena',
            messages: [
                {
                    role: 'assistant',
                    choice,
                    continued_with: 'none',
                    responses: {
                        model_a: { name: 'm-a', messages: [[{ type: 'text', content: 'A' }]] },
                        model_b: { name: 'm-b', messages: [[{ type: 'text', content: 'B' }]] }
                    }
                }
            ]
        });

        expect(serializeChatToMarkdown(makeArena('draw'))).toContain('*Result: draw*');
        expect(serializeChatToMarkdown(makeArena('no_choice(bothbad)'))).toContain('*Result: no choice (both bad)*');
        expect(serializeChatToMarkdown(makeArena('timeout'))).toContain('*Result: timeout*');
    });

    test('omits arena result lines for ignored and reveal choices', () => {
        const makeArena = (choice, continuedWith) => ({
            title: 'Arena',
            messages: [
                {
                    role: 'assistant',
                    choice,
                    continued_with: continuedWith,
                    responses: {
                        model_a: { name: 'm-a', messages: [[{ type: 'text', content: 'A' }]] },
                        model_b: { name: 'm-b', messages: [[{ type: 'text', content: 'B' }]] }
                    }
                }
            ]
        });

        const ignored = serializeChatToMarkdown(makeArena('ignored', ''));
        expect(ignored).not.toContain('*Result:');
        expect(ignored).not.toContain('*Winner:');
        expect(ignored).not.toContain('*Continued with');

        const revealed = serializeChatToMarkdown(makeArena('reveal', 'model_b'));
        expect(revealed).not.toContain('*Result:');
        expect(revealed).toContain('*Continued with Model B (m-b)*');
    });

    test('falls back to generic arena branch names and avoids duplication', () => {
        const chat = {
            title: 'Arena',
            messages: [
                {
                    role: 'assistant',
                    choice: 'ignored',
                    continued_with: '',
                    responses: {
                        model_a: { name: 'Model A', messages: [[{ type: 'text', content: 'A' }]] },
                        model_b: { name: '', messages: [[{ type: 'text', content: 'B' }]] }
                    }
                }
            ]
        };

        const markdown = serializeChatToMarkdown(chat);
        expect(markdown).toContain('**Model A:**\n\nA');
        expect(markdown).toContain('**Model B:**\n\nB');
        expect(markdown).not.toContain('Model A (Model A)');
    });

    test('omits empty arena messages entirely', () => {
        const chat = {
            title: 'Empty arena',
            messages: [
                { role: 'user', contents: [[{ type: 'text', content: 'Hi' }]] },
                {
                    role: 'assistant',
                    choice: 'ignored',
                    continued_with: '',
                    responses: {
                        model_a: { name: 'm-a', messages: [] },
                        model_b: { name: 'm-b', messages: [] }
                    }
                }
            ]
        };

        expect(serializeChatToMarkdown(chat)).toBe(
            '# Empty arena\n' +
            '\n' +
            '**You:**\n' +
            '\n' +
            'Hi\n'
        );
    });

    test('serializes council member responses and collector summary', () => {
        const chat = {
            title: 'Council chat',
            messages: [
                { role: 'user', contents: [[{ type: 'text', content: 'Advise me' }]] },
                {
                    role: 'assistant',
                    contents: [[{ type: 'text', content: 'Synthesized answer', model: 'gpt-5.2' }]],
                    council: {
                        collector_model: 'gpt-5.2',
                        responses: {
                            'gpt-5.2': { name: 'gpt-5.2', parts: [{ type: 'text', content: 'Opinion A' }] },
                            'gemini-3.1-pro': {
                                name: 'gemini-3.1-pro',
                                parts: [
                                    { type: 'thought', content: 'pondering' },
                                    { type: 'text', content: 'Opinion B' }
                                ]
                            }
                        }
                    }
                }
            ]
        };

        expect(serializeChatToMarkdown(chat)).toBe(
            '# Council chat\n' +
            '\n' +
            '**You:**\n' +
            '\n' +
            'Advise me\n' +
            '\n' +
            '**Council:**\n' +
            '\n' +
            '**gpt-5.2:**\n' +
            '\n' +
            'Opinion A\n' +
            '\n' +
            '**gemini-3.1-pro:**\n' +
            '\n' +
            '> *Thinking:*\n' +
            '> pondering\n' +
            '\n' +
            'Opinion B\n' +
            '\n' +
            '**Council summary (gpt-5.2):**\n' +
            '\n' +
            'Synthesized answer\n'
        );
    });

    test('falls back to response key when council member has no name', () => {
        const chat = {
            title: 'Council',
            messages: [
                {
                    role: 'assistant',
                    contents: [],
                    council: {
                        collector_model: 'gpt-5.2',
                        responses: {
                            'kimi-k3': { parts: [{ type: 'text', content: 'Unnamed opinion' }] }
                        }
                    }
                }
            ]
        };

        const markdown = serializeChatToMarkdown(chat);
        expect(markdown).toContain('**kimi-k3:**\n\nUnnamed opinion');
        expect(markdown).not.toContain('Council summary');
    });

    test('marks regenerated collector summaries with arrow', () => {
        const chat = {
            title: 'Council',
            messages: [
                {
                    role: 'assistant',
                    contents: [
                        [{ type: 'text', content: 'Summary v1', model: 'gpt-5.2' }],
                        [{ type: 'text', content: 'Summary v2', model: 'gpt-5.2' }]
                    ],
                    council: { collector_model: 'gpt-5.2', responses: {} }
                }
            ]
        };

        const markdown = serializeChatToMarkdown(chat);
        expect(markdown).toContain('**Council summary (gpt-5.2):**\n\nSummary v1');
        expect(markdown).toContain('**Council summary (gpt-5.2) ⟳:**\n\nSummary v2');
    });

    test('omits empty council messages entirely', () => {
        const chat = {
            title: 'Empty council',
            messages: [
                { role: 'user', contents: [[{ type: 'text', content: 'Hi' }]] },
                {
                    role: 'assistant',
                    contents: [],
                    council: {
                        collector_model: 'gpt-5.2',
                        responses: { 'm-x': { name: 'm-x', parts: [] } }
                    }
                }
            ]
        };

        expect(serializeChatToMarkdown(chat)).toBe(
            '# Empty council\n' +
            '\n' +
            '**You:**\n' +
            '\n' +
            'Hi\n'
        );
    });

    test('passes markdown source through verbatim without adding HTML', () => {
        const rawContent = 'Use `<div class="x">` inline\n\n**bold** and <script>alert(1)</script>\n\n- list item';
        const chat = {
            title: 'Raw',
            messages: [
                { role: 'assistant', contents: [[{ type: 'text', content: rawContent, model: 'm' }]] }
            ]
        };

        const markdown = serializeChatToMarkdown(chat);
        expect(markdown).toContain(rawContent);
        expect(serializeChatToMarkdown(chat)).toBe(markdown);
    });

    test('produces identical output on repeated serialization', () => {
        const chat = {
            title: 'Deterministic',
            messages: [
                { role: 'user', contents: [[{ type: 'text', content: 'Hi' }]], images: ['h'] },
                {
                    role: 'assistant',
                    choice: 'model_b',
                    continued_with: 'model_b',
                    responses: {
                        model_a: { name: 'a', messages: [[{ type: 'text', content: 'A' }]] },
                        model_b: { name: 'b', messages: [[{ type: 'thought', content: 't' }, { type: 'text', content: 'B' }]] }
                    }
                }
            ]
        };

        expect(serializeChatToMarkdown(chat)).toBe(serializeChatToMarkdown(chat));
    });
});
