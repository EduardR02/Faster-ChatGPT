import { describe, expect, test } from 'bun:test';
import { DeepSeekProvider, RoleEnum } from '../../src/js/LLMProviders.js';
import { createMockTokenCounter, createMockWriter } from '../setup.mjs';

const provider = new DeepSeekProvider();

const IMAGE = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const createBody = (model, messages, options = {}) => {
    const [, request] = provider.createRequest({
        model,
        messages,
        stream: true,
        options,
        apiKey: 'key',
        settings: { temperature: 0.7, max_tokens: 32000 }
    });
    return JSON.parse(request.body);
};

const userMessage = (text, images) => ({
    role: RoleEnum.user,
    parts: [{ type: 'text', content: text }],
    ...(images && { images })
});

// Docs: images travel in the standard OpenAI-compatible content block array
// ({"type":"image_url","image_url":{"url":...}}) and only the Flash family reads them.
describe('DeepSeek V4.1 Flash vision', () => {
    test('serializes user images as documented image_url blocks', () => {
        const body = createBody('deepseek-flash', [
            userMessage('What is in this image?', [IMAGE, 'https://example.com/image.jpg'])
        ]);

        expect(body.messages).toEqual([{
            role: 'user',
            content: [
                { type: 'text', text: 'What is in this image?' },
                { type: 'image_url', image_url: { url: IMAGE } },
                { type: 'image_url', image_url: { url: 'https://example.com/image.jpg' } }
            ]
        }]);
    });

    test('serves the retired Flash aliases from the same vision path', () => {
        for (const model of ['deepseek-flash', 'deepseek-v4-flash', 'deepseek-v4-flash-vision-exp']) {
            const body = createBody(model, [userMessage('Look', [IMAGE])]);
            expect(body.messages[0].content).toEqual([
                { type: 'text', text: 'Look' },
                { type: 'image_url', image_url: { url: IMAGE } }
            ]);
        }
    });

    test('keeps text-only DeepSeek ids on the plain string contract', () => {
        for (const model of ['deepseek-v4-pro', 'deepseek-chat', 'deepseek-reasoner']) {
            const body = createBody(model, [userMessage('Look', [IMAGE])]);
            expect(body.messages[0]).toEqual({ role: 'user', content: 'Look' });
            expect(JSON.stringify(body)).not.toContain('image_url');
        }
    });

    test('keeps text-only Flash turns as plain strings', () => {
        const body = createBody('deepseek-flash', [userMessage('Hello')]);
        expect(body.messages[0]).toEqual({ role: 'user', content: 'Hello' });
    });

    test('omits the empty text block when a user turn only carries images', () => {
        const body = createBody('deepseek-flash', [
            { role: RoleEnum.user, parts: [{ type: 'text', content: '' }], images: [IMAGE] }
        ]);
        expect(body.messages[0].content).toEqual([{ type: 'image_url', image_url: { url: IMAGE } }]);
    });

    test('stays off the image generation capability', () => {
        for (const model of ['deepseek-flash', 'deepseek-v4-flash-vision-exp', 'deepseek-v4-pro']) {
            expect(provider.supports('image', model)).toBe(false);
        }
    });
});

// Docs: with stream_options.include_usage every chunk carries `usage` (null except the last) and no
// separate usage-only chunk is emitted - the final chunk's single choice carries no new content plus
// a non-null finish_reason.
describe('DeepSeek streaming usage chunk', () => {
    for (const delta of [{}, { content: '' }]) {
        test(`counts usage from a final chunk with delta ${JSON.stringify(delta)}`, () => {
            const writer = createMockWriter();
            const tokenCounter = createMockTokenCounter();

            provider.handleStream({ parsed: { choices: [{ delta: { content: 'Hi' } }], usage: null }, writer, tokenCounter });
            expect(tokenCounter.inputTokens).toBe(0);

            provider.handleStream({
                parsed: { choices: [{ delta, finish_reason: 'stop' }], usage: { prompt_tokens: 12, completion_tokens: 7 } },
                writer,
                tokenCounter
            });

            expect(tokenCounter.inputTokens).toBe(12);
            expect(tokenCounter.outputTokens).toBe(7);
            expect(writer.getFinalContent()).toEqual([{ type: 'text', content: 'Hi' }]);
        });
    }
});
