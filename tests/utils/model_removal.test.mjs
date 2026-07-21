import { describe, expect, test } from 'bun:test';
import { resolveModelRemoval } from '../../src/js/model_removal.js';

const models = {
  openai: {
    'GPT-Case': 'Primary Model',
    'gpt-case': 'Secondary Model',
    survivor: 'Survivor'
  },
  anthropic: {
    claude: 'Claude'
  }
};

const resolve = (overrides = {}) => resolveModelRemoval({
  models,
  displayName: '',
  apiName: '',
  mode: 'normal',
  selectedModelIds: [],
  ...overrides
});

describe('model removal resolution', () => {
  test('resolves entered API and display names case-insensitively to stored casing', () => {
    expect(resolve({ apiName: 'SURVIVOR' })).toEqual({
      provider: 'openai',
      apiName: 'survivor',
      displayName: 'Survivor'
    });
    expect(resolve({ displayName: 'cLaUdE' })).toEqual({
      provider: 'anthropic',
      apiName: 'claude',
      displayName: 'Claude'
    });
  });

  test('does not depend on locale-sensitive case conversion', () => {
    const original = String.prototype.toLocaleLowerCase;
    String.prototype.toLocaleLowerCase = () => { throw new Error('locale conversion used'); };
    try {
      expect(resolve({ apiName: 'SURVIVOR' })?.apiName).toBe('survivor');
    } finally {
      String.prototype.toLocaleLowerCase = original;
    }
  });

  test('prefers exact case and rejects an unresolved case-insensitive ambiguity', () => {
    expect(resolve({ apiName: 'GPT-Case' })?.displayName).toBe('Primary Model');
    expect(resolve({ apiName: 'GPT-CASE' })).toBeNull();
  });

  test('uses both entered fields to disambiguate without choosing conflicting exact matches', () => {
    expect(resolve({ apiName: 'GPT-CASE', displayName: 'secondary model' })?.apiName).toBe('gpt-case');
    expect(resolve({
      models: { openai: { Foo: 'Name', foo: 'name' } },
      apiName: 'Foo',
      displayName: 'name'
    })).toBeNull();
  });

  test('falls back only to one exact normal-chat selection', () => {
    expect(resolve({ selectedModelIds: ['survivor'] })?.apiName).toBe('survivor');
    expect(resolve({ selectedModelIds: [] })).toBeNull();
    expect(resolve({ selectedModelIds: ['survivor', 'claude'] })).toBeNull();
  });

  test('does not infer removal from arena or council selections', () => {
    expect(resolve({ mode: 'arena', selectedModelIds: ['survivor', 'claude'] })).toBeNull();
    expect(resolve({ mode: 'council', selectedModelIds: ['survivor', 'claude'] })).toBeNull();
  });
});
