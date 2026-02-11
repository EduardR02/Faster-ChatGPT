import { describe, test, expect } from 'bun:test';
import { SidepanelController } from '../../src/js/sidepanel_controller.js';

describe('SidepanelController sendUserMessage persistence behavior', () => {
    test('starts api flow before user message persistence resolves', async () => {
        const controller = Object.create(SidepanelController.prototype);
        const callOrder = [];
        let resolveSave;
        let saveResolved = false;

        const savePromise = new Promise(resolve => {
            resolveSave = () => {
                saveResolved = true;
                resolve();
            };
        });

        const latestUserMessage = {
            role: 'user',
            contents: [[{ type: 'text', content: 'hello' }]]
        };

        controller.chatUI = {
            getTextareaText: () => 'hello',
            setTextareaText: () => callOrder.push('setTextareaText'),
            addMessage: () => callOrder.push('addMessage'),
            removeRegenerateButtons: () => callOrder.push('removeRegenerateButtons'),
            removeCurrentRemoveMediaButtons: () => callOrder.push('removeCurrentRemoveMediaButtons')
        };

        controller.chatCore = {
            addUserMessage: () => {
                callOrder.push('addUserMessage');
                return savePromise;
            },
            getLength: () => 1,
            getLatestMessage: () => latestUserMessage
        };

        controller.getContinueFunc = () => undefined;
        controller.handleDefaultArenaChoice = () => {
            callOrder.push('handleDefaultArenaChoice');
        };
        controller.initApiCall = async () => {
            callOrder.push('initApiCall');
        };

        const result = controller.sendUserMessage();

        expect(result).toBeUndefined();
        expect(saveResolved).toBe(false);
        expect(callOrder.includes('initApiCall')).toBe(false);

        await Promise.resolve();

        expect(callOrder).toContain('initApiCall');
        expect(saveResolved).toBe(false);

        resolveSave();
        await savePromise;
    });
});
