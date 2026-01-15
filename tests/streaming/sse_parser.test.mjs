import { describe, test, expect } from 'bun:test';
import { ApiManager } from '../../src/js/api_manager.js';

const parseSSEChunk = ApiManager.parseSSEChunk;

describe('SSE parsing', () => {
  test('parses complete events', () => {
    const state = { buffer: '' };
    const events = parseSSEChunk(state, 'data: {"text":"hello"}\ndata: {"text":"world"}\n');
    
    expect(events).toHaveLength(2);
    expect(events[0]).toEqual({ text: 'hello' });
    expect(events[1]).toEqual({ text: 'world' });
    expect(state.buffer).toBe('');
  });
  
  test('handles split chunks', () => {
    const state = { buffer: '' };
    let allEvents = [];
    
    // First chunk - incomplete
    let events = parseSSEChunk(state, 'data: {"text":"hel');
    allEvents.push(...events);
    expect(state.buffer).toBe('data: {"text":"hel');
    
    // Second chunk - completes previous + new
    events = parseSSEChunk(state, 'lo"}\ndata: {"text":"world"}\n');
    allEvents.push(...events);
    
    expect(allEvents).toHaveLength(2);
    expect(allEvents[0]).toEqual({ text: 'hello' });
    expect(allEvents[1]).toEqual({ text: 'world' });
    expect(state.buffer).toBe('');
  });
  
  test('ignores [DONE] marker', () => {
    const state = { buffer: '' };
    const events = parseSSEChunk(state, 'data: {"text":"hi"}\ndata: [DONE]\n');
    expect(events).toHaveLength(1);
  });
  
  test('skips malformed JSON silently', () => {
    const state = { buffer: '' };
    const events = parseSSEChunk(state, 'data: {"valid":true}\ndata: not json\ndata: {"also":"valid"}\n');
    expect(events).toHaveLength(2);
    expect(events[0]).toEqual({ valid: true });
    expect(events[1]).toEqual({ also: 'valid' });
  });
  
  test('handles empty lines', () => {
    const state = { buffer: '' };
    const events = parseSSEChunk(state, '\n\ndata: {"text":"hi"}\n\n');
    expect(events).toHaveLength(1);
  });
});
