import { describe, expect, test } from 'bun:test';
import { findFirstAvailableModel } from '../../src/js/model_selection.js';

describe('findFirstAvailableModel', () => {
  const models = () => ({
    openai: { 'gpt-a': 'GPT A', 'gpt-b': 'GPT B' },
    anthropic: { claude: 'Claude' }
  });

  test('returns the first configured model', () => {
    expect(findFirstAvailableModel(models())).toBe('gpt-a');
  });

  test('skips the excluded model within a provider', () => {
    expect(findFirstAvailableModel(models(), 'gpt-a')).toBe('gpt-b');
  });

  test('crosses provider boundaries when a provider is exhausted', () => {
    expect(findFirstAvailableModel({
      openai: { 'gpt-a': 'GPT A' },
      anthropic: { claude: 'Claude' }
    }, 'gpt-a')).toBe('claude');
  });

  test('returns null when every model is excluded or none exist', () => {
    expect(findFirstAvailableModel({ openai: { 'gpt-a': 'GPT A' } }, 'gpt-a')).toBeNull();
    expect(findFirstAvailableModel({})).toBeNull();
    expect(findFirstAvailableModel(undefined)).toBeNull();
  });
});
