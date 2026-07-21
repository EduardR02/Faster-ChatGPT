import { beforeEach, describe, expect, test } from 'bun:test';
import { parseHTML } from 'linkedom';
import { HistoryChatUI, SidepanelChatUI } from '../../src/js/chat_ui.js';
import { SidepanelApp } from '../../src/js/sidepanel.js';

const deferred = () => {
    let resolve;
    const promise = new Promise(resolvePromise => { resolve = resolvePromise; });
    return { promise, resolve };
};

const textParts = content => [[{ type: 'text', content }]];

const createStateManager = () => ({
    getSetting: key => key === 'models' ? {} : false,
    getArenaModel: index => `arena-${index}`,
    getCouncilCollectorModel: () => 'collector',
    isThinking: () => false,
    isSolving: () => false,
    subscribeToSetting: () => {},
    unsubscribeFromSetting: () => {}
});

const topLevelBlocks = () => Array.from(document.getElementById('conversation').children)
    .filter(element => !element.classList.contains('title-wrapper'));

const blockMarker = element => {
    if (element.classList.contains('council-message')) return 'council';
    if (element.querySelector('.arena-full-container')) return 'arena';
    return element.querySelector('.message-content')?.textContent;
};

describe('chunked chat rendering', () => {
    beforeEach(() => {
        const { document, window } = parseHTML(`
            <div id="scroll-container">
                <div id="conversation">
                    <div class="title-wrapper"><span class="conversation-title">conversation</span></div>
                </div>
            </div>
            <div id="title-wrapper"><span id="history-chat-header">conversation</span></div>
            <div id="history-conversation"></div>
            <div id="history-chat-footer"></div>
            <div id="history-list"></div>
            <div class="textarea-wrapper"><textarea></textarea></div>
        `);
        globalThis.document = document;
        globalThis.window = window;
    });

    test('yields between deterministic chunks without changing order, council, regenerations, or absolute indices', async () => {
        const scheduled = [];
        const continued = [];
        const messages = Array.from({ length: 45 }, (_, index) => ({
            role: index % 2 === 0 ? 'user' : 'assistant',
            contents: textParts(`message-${index}`)
        }));
        messages[19].contents = [
            [{ type: 'text', content: 'message-19-a' }],
            [{ type: 'text', content: 'message-19-b' }]
        ];
        messages[20] = { role: 'assistant', contents: textParts('message-20') };
        messages[30] = {
            role: 'assistant',
            contents: textParts('council-collector'),
            council: {
                collector_model: 'collector',
                responses: {
                    critic: { name: 'Critic', parts: [{ type: 'text', content: 'council-row' }], status: 'complete' }
                }
            }
        };

        const chatUI = new SidepanelChatUI({
            conversationWrapperId: 'conversation',
            scrollElementId: 'scroll-container',
            stateManager: createStateManager(),
            continueFunc: (...args) => continued.push(args),
            renderScheduler: () => {
                const task = deferred();
                scheduled.push(task);
                return task.promise;
            }
        });

        const rendering = chatUI.buildChat({ title: 'Large chat', messages }, { indexOffset: 100 });

        expect(rendering).toBeInstanceOf(Promise);
        expect(scheduled).toHaveLength(1);
        expect(topLevelBlocks()).toHaveLength(21);

        scheduled.shift().resolve();
        await Promise.resolve();
        expect(scheduled).toHaveLength(1);
        expect(topLevelBlocks()).toHaveLength(41);

        scheduled.shift().resolve();
        expect(await rendering).toBe(true);
        expect(scheduled).toHaveLength(0);
        expect(topLevelBlocks()).toHaveLength(46);

        const expectedOrder = messages.flatMap((message, index) => {
            if (message.council) return ['council'];
            if (index === 19) return ['message-19-a', 'message-19-b'];
            return [`message-${index}`];
        });
        expect(topLevelBlocks().map(blockMarker)).toEqual(expectedOrder);

        const regenerationBlocks = topLevelBlocks().filter(element =>
            ['message-19-b', 'message-20'].includes(blockMarker(element))
        );
        expect(regenerationBlocks.map(element => element.querySelector('.message-prefix').textContent)).toEqual([
            'Assistant ⟳',
            'Assistant ⟳'
        ]);

        topLevelBlocks().find(element => blockMarker(element) === 'message-19-b')
            .querySelector('.continue-conversation-button').click();
        topLevelBlocks().find(element => blockMarker(element) === 'message-20')
            .querySelector('.continue-conversation-button').click();
        document.querySelector('.council-continue-button').click();
        expect(continued).toEqual([
            [119, 1],
            [120, 0],
            [130, 0]
        ]);
    });

    test('HistoryChatUI resumes arena rendering in the next chunk before applying history metadata', async () => {
        const scheduled = [];
        const continued = [];
        const messages = Array.from({ length: 25 }, (_, index) => ({
            role: index % 2 === 0 ? 'user' : 'assistant',
            contents: textParts(`history-${index}`)
        }));
        messages[20] = {
            role: 'assistant',
            responses: {
                model_a: { name: 'Arena A', messages: textParts('arena-a') },
                model_b: { name: 'Arena B', messages: textParts('arena-b') }
            },
            choice: 'draw',
            continued_with: 'model_a'
        };
        const stateManager = {
            ...createStateManager(),
            historyList: document.getElementById('history-list'),
            limit: 20,
            offset: 0,
            shouldLoadMore: () => false
        };
        const chatUI = new HistoryChatUI({
            conversationWrapperId: 'history-conversation',
            stateManager,
            continueFunc: (...args) => continued.push(args),
            addPopupActions: () => {},
            loadHistoryItems: async () => [],
            loadChat: async () => ({
                chatId: 7,
                title: 'History arena',
                timestamp: 123,
                continued_from_chat_id: null,
                messages
            }),
            getChatMeta: async () => null,
            renderScheduler: () => {
                const task = deferred();
                scheduled.push(task);
                return task.promise;
            }
        });

        const rendering = chatUI.buildChat(7);
        await Promise.resolve();
        expect(scheduled).toHaveLength(1);
        expect(document.getElementById('history-conversation').children).toHaveLength(20);
        expect(document.getElementById('history-chat-header').textContent).toBe('conversation');

        scheduled.shift().resolve();
        expect(await rendering).toBe(true);
        const blocks = Array.from(document.getElementById('history-conversation').children);
        expect(blocks).toHaveLength(25);
        expect(blockMarker(blocks[20])).toBe('arena');
        expect(document.getElementById('history-chat-header').textContent).toBe('History arena');

        blocks[20].querySelector('.arena-wrapper[data-model-key="model_b"] .continue-conversation-button').click();
        expect(continued).toEqual([[20, 0, 'model_b']]);
    });

    test('a newer build cancels queued chunks from the previous conversation', async () => {
        const scheduled = [];
        const chatUI = new SidepanelChatUI({
            conversationWrapperId: 'conversation',
            scrollElementId: 'scroll-container',
            stateManager: createStateManager(),
            renderScheduler: () => {
                const task = deferred();
                scheduled.push(task);
                return task.promise;
            }
        });
        const oldMessages = Array.from({ length: 25 }, (_, index) => ({
            role: 'user',
            contents: textParts(`old-${index}`)
        }));

        const oldRendering = chatUI.buildChat({ title: 'Old', messages: oldMessages });
        expect(scheduled).toHaveLength(1);

        expect(chatUI.buildChat({
            title: 'New',
            messages: [{ role: 'user', contents: textParts('new-message') }]
        })).toBeUndefined();
        expect(topLevelBlocks().map(blockMarker)).toEqual(['new-message']);

        scheduled.shift().resolve();
        expect(await oldRendering).toBe(false);
        expect(topLevelBlocks().map(blockMarker)).toEqual(['new-message']);
        expect(document.querySelector('.conversation-title').textContent).toBe('New');
    });

    test('lazy reconstruction restores pending media only after chunked rendering completes', async () => {
        const rendering = deferred();
        const events = [];
        const chat = { chatId: 7, title: 'Restored', messages: [] };
        const chatCore = {
            continuedChatOptions: {},
            buildFromDB: restored => { chat.messages = restored.messages; },
            getChat: () => chat,
            hasChatStarted: () => true
        };
        const tab = {
            id: 'tab-7',
            tabState: { chatId: null },
            chatUI: {
                updateIncognito: () => {},
                buildChat: (renderChat, options) => {
                    events.push(['build', renderChat, options]);
                    return rendering.promise;
                }
            },
            controller: {
                chatCore,
                initStates: () => {},
                syncWebpageContextUI: () => events.push(['context']),
                restoreLatestAssistantActions: () => events.push(['actions'])
            }
        };
        const app = Object.create(SidepanelApp.prototype);
        app.getContinuationRenderChat = renderChat => ({ chat: renderChat, indexOffset: 40 });
        app.restorePendingUserMessage = (_tab, message) => events.push(['pending', message]);
        app.tabManager = {
            updateTabTitle: () => events.push(['title']),
            schedulePersist: () => events.push(['persist'])
        };
        const pendingUserMessage = { role: 'user', images: ['pending-image'] };

        const committing = app.commitReconstruction(tab, {
            options: { chatId: 7, index: 44, secondaryIndex: 0, modelChoice: null, pendingUserMessage },
            chat: { ...chat, messages: [{ role: 'user', contents: textParts('stored') }] },
            chatId: 7,
            isContinuation: true,
            selectedMessage: { role: 'assistant' },
            fullChatLength: 45,
            secondaryLength: 1
        });

        expect(events).toEqual([['build', chat, { indexOffset: 40 }]]);
        expect(tab.tabState.chatId).toBeNull();

        rendering.resolve(true);
        expect(await committing).toBe(true);
        expect(events.map(event => event[0])).toEqual(['build', 'context', 'pending', 'title', 'persist', 'actions']);
        expect(events[2]).toEqual(['pending', pendingUserMessage]);
        expect(tab.tabState.chatId).toBe(7);
    });
});
