/**
 * The model roster's behaviour (model-forms.model.ts), as an operator
 * using the Agent models page would describe it. The browser spec
 * (e2e/llm-models.spec.ts) keeps one walk of the page end to end: the
 * empty state, a filled form, Test connection answered at the browser
 * edge, a real Save, the saved row and the phone-width form.
 */

import {
  borrowFromId,
  canList,
  canTest,
  dataHandlingWarningOf,
  draftOf,
  emptyDraft,
  formView,
  initialModelForms,
  isLoading,
  keyedSiblings,
  listRequest,
  modelFormsReducer,
  rowView,
  saveRequest,
  showsEmpty,
  testRequest,
  type DraftEdit,
  type ModelFormsAction,
  type ModelFormsState,
  type ModelRow,
} from './model-forms.model';

const row = (id: string, more: Partial<ModelRow> = {}): ModelRow => ({
  id,
  label: `Model ${id}`,
  provider: 'anthropic',
  model: 'claude-sonnet-5',
  baseUrl: null,
  settings: null,
  enabled: true,
  isDefault: false,
  hasApiKey: true,
  ...more,
});

const run = (actions: ModelFormsAction[], from: ModelFormsState = initialModelForms) =>
  actions.reduce(modelFormsReducer, from);

function edit<A extends Omit<DraftEdit, 'type'>>(change: A): { type: 'edited' } & A {
  return { type: 'edited', ...change };
}

/** A new-model form over a roster of these rows. */
const adding = (...rows: ModelRow[]) =>
  run([{ type: 'loaded', models: rows }, { type: 'startCreate' }]);

/** A new model with a label, a model id and a typed key: ready to test and save. */
const filled = (more: ModelFormsAction[] = [], ...rows: ModelRow[]) =>
  run(
    [
      edit({ field: 'label', value: 'Prod Claude' }),
      edit({ field: 'model', value: 'claude-sonnet-5' }),
      edit({ field: 'apiKey', value: 'sk-ant-key' }),
      ...more,
    ],
    adding(...rows)
  );

const bodyOf = (state: ModelFormsState) => {
  const request = saveRequest(state);
  if (!request.ok) throw new Error(`refused: ${request.error}`);
  return request.body;
};

describe('the roster', () => {
  it('shows a skeleton until the first load answers, then the rows or the empty state', () => {
    expect(isLoading(initialModelForms)).toBe(true);
    const empty = run([{ type: 'loaded', models: [] }]);
    expect(isLoading(empty)).toBe(false);
    expect(showsEmpty(empty)).toBe(true);
    expect(showsEmpty(run([{ type: 'loaded', models: [row('a')] }]))).toBe(false);
  });

  it('a failed load says why, and stops the skeleton', () => {
    const failed = run([{ type: 'loadFailed', error: 'Unauthorized' }]);
    expect(failed.loadError).toBe('Unauthorized');
    expect(isLoading(failed)).toBe(false);
    expect(run([{ type: 'loadFailed', error: null }]).loadError).toBe('Could not load models');
    expect(run([{ type: 'loaded', models: [] }], failed).loadError).toBeNull();
  });

  it('the empty state goes while the first model is being added', () => {
    expect(showsEmpty(adding())).toBe(false);
  });

  it('a refused remove says why above the list', () => {
    const state = run([{ type: 'removeFailed', error: 'Not found' }], adding(row('a')));
    expect(state.loadError).toBe('Not found');
  });
});

describe('a roster row', () => {
  it('nothing said about data handling reads "Not BAA-covered"', () => {
    expect(rowView(row('a')).warning).toBe('Not BAA-covered');
    expect(rowView(row('a', { settings: { providerRetention: 'none' } })).warning).toBe(
      'Not BAA-covered'
    );
  });

  it('a BAA without a retention term still warns that retention is unknown', () => {
    expect(dataHandlingWarningOf(row('a', { settings: { baaCovered: true } }))).toBe(
      'Retention unknown'
    );
    expect(
      dataHandlingWarningOf(
        row('a', { settings: { baaCovered: true, providerRetention: 'unknown' } })
      )
    ).toBe('Retention unknown');
  });

  it('a BAA and a retention term clear the warning', () => {
    expect(
      rowView(row('a', { settings: { baaCovered: true, providerRetention: 'none' } })).warning
    ).toBeNull();
  });

  it('says it is the default, disabled, or draws pictures, and whether a key is stored', () => {
    expect(rowView(row('a', { isDefault: true })).isDefault).toBe(true);
    expect(rowView(row('a', { enabled: false })).disabled).toBe(true);
    expect(rowView(row('a', { settings: { apiSurface: 'images' } })).imageGeneration).toBe(true);
    expect(rowView(row('a', { settings: { apiSurface: 'flux' } })).imageGeneration).toBe(true);
    expect(rowView(row('a', { settings: { apiSurface: 'responses' } })).imageGeneration).toBe(
      false
    );
    expect(rowView(row('a', { hasApiKey: false })).keyStored).toBe(false);
    expect(rowView(row('a')).keyStored).toBe(true);
  });
});

describe('opening the form', () => {
  it('the first model is the organization default; a later one is not', () => {
    expect(adding().draft).toEqual({ ...emptyDraft, isDefault: true });
    expect(adding(row('a')).draft.isDefault).toBe(false);
  });

  it('a new model starts on Anthropic, enabled, with a key required and the Add title', () => {
    const state = adding();
    expect(state.editingId).toBe('new');
    expect(state.draft.provider).toBe('anthropic');
    expect(state.draft.enabled).toBe(true);
    expect(formView(state).keyRequired).toBe(true);
  });

  it('editing opens the row as stored, counts as plain numbers, the key blank', () => {
    const stored = row('a', {
      provider: 'openai',
      model: 'gpt-6-astra-1',
      baseUrl: 'https://res.openai.azure.com/openai/v1',
      isDefault: true,
      settings: {
        contextWindow: 1_000_000,
        maxOutputTokens: 4000,
        temperature: 0.2,
        apiVersion: 'preview',
        reasoningEffort: 'xhigh',
        apiSurface: 'responses',
        dataResidency: 'Azure East US, DataZone',
        providerRetention: 'none',
        baaCovered: true,
        notes: 'BAA signed 2026-01',
      },
    });
    const state = run([
      { type: 'loaded', models: [stored] },
      { type: 'startEdit', row: stored },
    ]);
    expect(state.editingId).toBe('a');
    expect(state.draft).toEqual({
      label: 'Model a',
      provider: 'openai',
      model: 'gpt-6-astra-1',
      baseUrl: 'https://res.openai.azure.com/openai/v1',
      maxOutputTokens: '4000',
      contextWindow: '1000000',
      temperature: '0.2',
      apiVersion: 'preview',
      reasoningEffort: 'xhigh',
      apiSurface: 'responses',
      dataResidency: 'Azure East US, DataZone',
      providerRetention: 'none',
      baaCovered: true,
      notes: 'BAA signed 2026-01',
      apiKey: '',
      apiKeyFromId: '',
      enabled: true,
      isDefault: true,
    });
    // A blank key keeps the stored one, so the field is not required.
    expect(formView(state).keyRequired).toBe(false);
  });

  it('a row saved with no settings opens with every optional field blank', () => {
    expect(draftOf(row('a'))).toMatchObject({
      contextWindow: '',
      maxOutputTokens: '',
      reasoningEffort: '',
      apiSurface: '',
      baaCovered: false,
    });
  });

  it('opening the form forgets the last one’s model list, test result and error', () => {
    const dirty = run(
      [
        { type: 'listed', models: [{ id: 'x', displayName: null }] },
        { type: 'tested', reply: 'ok' },
        { type: 'saveFailed', error: 'A model with this label already exists.' },
      ],
      filled()
    );
    for (const next of [
      run([{ type: 'startCreate' }], dirty),
      run([{ type: 'startEdit', row: row('a') }], dirty),
    ]) {
      expect(next.available).toBeNull();
      expect(next.testReply).toBeNull();
      expect(next.formError).toBeNull();
    }
  });

  it('Cancel closes the form and drops the draft', () => {
    const closed = run([{ type: 'closeForm' }], filled());
    expect(closed.editingId).toBeNull();
    expect(closed.draft).toEqual(emptyDraft);
  });
});

describe('provider and API surface', () => {
  it('Anthropic has no API surface to pick; OpenAI-compatible does', () => {
    expect(formView(adding()).showsApiSurface).toBe(false);
    const openai = run([edit({ field: 'provider', value: 'openai' })], adding());
    expect(formView(openai).showsApiSurface).toBe(true);
  });

  it('an OpenAI-compatible model can opt into the Responses API, and Save sends it', () => {
    const state = filled([
      edit({ field: 'provider', value: 'openai' }),
      edit({ field: 'apiSurface', value: 'responses' }),
    ]);
    expect(formView(state).showsResponsesHint).toBe(true);
    expect(formView(state).imageSurface).toBeNull();
    expect(bodyOf(state)).toMatchObject({ provider: 'openai', apiSurface: 'responses' });
  });

  it('chat completions is the default surface and Save leaves it unsaid', () => {
    const state = filled([edit({ field: 'provider', value: 'openai' })]);
    expect(formView(state).showsResponsesHint).toBe(true);
    expect(bodyOf(state)).not.toHaveProperty('apiSurface');
  });

  it('the Images API makes an image model: never the default, no chat test, its own hint', () => {
    const state = filled([
      edit({ field: 'provider', value: 'openai' }),
      edit({ field: 'isDefault', value: true }),
      edit({ field: 'apiSurface', value: 'images' }),
    ]);
    const view = formView(state);
    expect(view.imageSurface).toBe('images');
    expect(view.showsResponsesHint).toBe(false);
    expect(view.defaultBox).toEqual({ checked: false, disabled: true });
    expect(canTest(state)).toBe(false);
    // Off because it cannot be tested, not for something missing.
    expect(view.testMissing).toBe(false);
    expect(state.draft.isDefault).toBe(false);
  });

  it('FLUX is an image surface too, with its own hint', () => {
    const state = filled([
      edit({ field: 'provider', value: 'openai' }),
      edit({ field: 'apiSurface', value: 'flux' }),
    ]);
    expect(formView(state).imageSurface).toBe('flux');
    expect(formView(state).defaultBox.disabled).toBe(true);
    expect(canTest(state)).toBe(false);
  });

  it('the default box cannot be ticked on an image model', () => {
    const state = filled([
      edit({ field: 'provider', value: 'openai' }),
      edit({ field: 'apiSurface', value: 'images' }),
      edit({ field: 'isDefault', value: true }),
    ]);
    expect(state.draft.isDefault).toBe(false);
  });

  it('back to a chat surface brings back the test and the default box', () => {
    const state = filled([
      edit({ field: 'provider', value: 'openai' }),
      edit({ field: 'apiSurface', value: 'images' }),
      edit({ field: 'apiSurface', value: '' }),
    ]);
    expect(formView(state).defaultBox.disabled).toBe(false);
    expect(canTest(state)).toBe(true);
  });

  it('switching the provider to Anthropic drops the surface; back to OpenAI starts on chat', () => {
    const state = filled([
      edit({ field: 'provider', value: 'openai' }),
      edit({ field: 'apiSurface', value: 'images' }),
      edit({ field: 'provider', value: 'anthropic' }),
    ]);
    expect(state.draft.apiSurface).toBe('');
    expect(formView(state).showsApiSurface).toBe(false);
    const back = run([edit({ field: 'provider', value: 'openai' })], state);
    expect(back.draft.apiSurface).toBe('');
  });

  it('switching between OpenAI-compatible surfaces keeps the provider’s own choice', () => {
    const state = filled([
      edit({ field: 'provider', value: 'openai' }),
      edit({ field: 'apiSurface', value: 'responses' }),
      edit({ field: 'provider', value: 'openai' }),
    ]);
    expect(state.draft.apiSurface).toBe('responses');
  });
});

describe('reasoning effort', () => {
  it('a Claude row gets the output_config.effort hint, without "none" or "minimal"', () => {
    const view = formView(adding());
    expect(view.reasoningHint).toBe('anthropic');
    expect(view.reasoningSuggestions).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
  });

  it('an OpenAI-compatible row gets the reasoning-model hint, "none" and "minimal" included', () => {
    const view = formView(run([edit({ field: 'provider', value: 'openai' })], adding()));
    expect(view.reasoningHint).toBe('openai');
    expect(view.reasoningSuggestions).toEqual([
      'none',
      'minimal',
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
    ]);
  });

  it('is free text: any value the provider names is sent as typed', () => {
    const state = filled([edit({ field: 'reasoningEffort', value: 'ultra' })]);
    expect(bodyOf(state)).toMatchObject({ reasoningEffort: 'ultra' });
    expect(testRequest(state)).toMatchObject({ reasoningEffort: 'ultra' });
  });

  it('blank keeps the model’s own default and is left unsaid', () => {
    expect(bodyOf(filled())).not.toHaveProperty('reasoningEffort');
  });
});

describe('token counts', () => {
  it('the context window takes 200k, 1m or a plain number, sent as the whole count', () => {
    expect(bodyOf(filled([edit({ field: 'contextWindow', value: '200k' })])).contextWindow).toBe(
      200_000
    );
    expect(bodyOf(filled([edit({ field: 'contextWindow', value: '1m' })])).contextWindow).toBe(
      1_000_000
    );
    expect(bodyOf(filled([edit({ field: 'contextWindow', value: '400000' })])).contextWindow).toBe(
      400_000
    );
  });

  it('max output tokens takes 4k or 8000', () => {
    expect(bodyOf(filled([edit({ field: 'maxOutputTokens', value: '4k' })])).maxOutputTokens).toBe(
      4000
    );
    expect(
      bodyOf(filled([edit({ field: 'maxOutputTokens', value: '8000' })])).maxOutputTokens
    ).toBe(8000);
  });

  it('a context window that is not a count is refused, and says what it expects', () => {
    expect(saveRequest(filled([edit({ field: 'contextWindow', value: 'lots' })]))).toEqual({
      ok: false,
      error: 'Context window must be a token count, such as 200k or 1m.',
    });
  });

  it('max output tokens that is not a count is refused, and says what it expects', () => {
    expect(saveRequest(filled([edit({ field: 'maxOutputTokens', value: 'lots' })]))).toEqual({
      ok: false,
      error: 'Max output tokens must be a token count, such as 4k or 8000.',
    });
  });

  it('a refusal shows on the form and leaves the draft as typed', () => {
    const state = filled([edit({ field: 'contextWindow', value: 'lots' })]);
    const request = saveRequest(state);
    const refused = run([{ type: 'saveFailed', error: request.ok ? '' : request.error }], state);
    expect(refused.formError).toBe('Context window must be a token count, such as 200k or 1m.');
    expect(refused.editingId).toBe('new');
    expect(refused.draft.contextWindow).toBe('lots');
  });

  it('blank counts are left unsaid', () => {
    const body = bodyOf(filled([edit({ field: 'contextWindow', value: '  ' })]));
    expect(body).not.toHaveProperty('contextWindow');
    expect(body).not.toHaveProperty('maxOutputTokens');
  });
});

describe('List available models', () => {
  it('needs a key to ask with: typed, borrowed, or stored on the row being edited', () => {
    expect(canList(adding())).toBe(false);
    expect(formView(adding()).listMissing).toBe(true);
    expect(canList(run([edit({ field: 'apiKey', value: 'sk' })], adding()))).toBe(true);
    const sibling = row('s');
    expect(canList(run([edit({ field: 'apiKeyFromId', value: 's' })], adding(sibling)))).toBe(true);
    const stored = row('a');
    expect(
      canList(
        run([
          { type: 'loaded', models: [stored] },
          { type: 'startEdit', row: stored },
        ])
      )
    ).toBe(true);
    const keyless = row('b', { hasApiKey: false });
    expect(
      canList(
        run([
          { type: 'loaded', models: [keyless] },
          { type: 'startEdit', row: keyless },
        ])
      )
    ).toBe(false);
  });

  it('asks with the typed key over a stored one', () => {
    const stored = row('a');
    const state = run([
      { type: 'loaded', models: [stored] },
      { type: 'startEdit', row: stored },
      edit({ field: 'apiKey', value: 'sk-new' }),
      edit({ field: 'apiVersion', value: ' preview ' }),
    ]);
    expect(listRequest(state)).toEqual({
      provider: 'anthropic',
      baseUrl: null,
      apiVersion: 'preview',
      apiKey: 'sk-new',
    });
  });

  it('without a typed key, the server lends the edited row’s stored key', () => {
    const stored = row('a', { baseUrl: 'https://gw.example' });
    const state = run([
      { type: 'loaded', models: [stored] },
      { type: 'startEdit', row: stored },
    ]);
    expect(borrowFromId(state)).toBe('a');
    expect(listRequest(state)).toEqual({
      provider: 'anthropic',
      baseUrl: 'https://gw.example',
      modelConfigId: 'a',
    });
  });

  it('the live answer replaces the usual suggestions', () => {
    expect(formView(adding()).modelSuggestions).toContain('claude-sonnet-5');
    const listed = run(
      [
        { type: 'listSent' },
        {
          type: 'listed',
          models: [
            { id: 'claude-sonnet-5', displayName: 'Claude Sonnet 5' },
            { id: 'claude-opus-5', displayName: null },
          ],
        },
      ],
      filled()
    );
    expect(listed.listing).toBe(false);
    expect(formView(listed).modelSuggestions).toEqual(['claude-sonnet-5', 'claude-opus-5']);
  });

  it('a failed listing says why and shows no list', () => {
    const failed = run(
      [
        { type: 'listed', models: [{ id: 'x', displayName: null }] },
        { type: 'listSent' },
        { type: 'listFailed', error: 'Invalid API key' },
      ],
      filled()
    );
    expect(failed.available).toBeNull();
    expect(failed.listError).toBe('Invalid API key');
    expect(run([{ type: 'listFailed', error: undefined }], filled()).listError).toBe(
      'Could not list models'
    );
  });

  it('changing the connection forgets the list it answered for', () => {
    const listed = run([{ type: 'listed', models: [{ id: 'x', displayName: null }] }], filled());
    for (const change of [
      edit({ field: 'provider', value: 'openai' }),
      edit({ field: 'baseUrl', value: 'https://gw' }),
      edit({ field: 'apiKey', value: 'sk-other' }),
      edit({ field: 'apiVersion', value: 'preview' }),
      edit({ field: 'apiKeyFromId', value: 's' }),
      edit({ field: 'apiSurface', value: 'responses' }),
    ]) {
      expect(run([change], listed).available).toBeNull();
    }
  });

  it('the model id, labels and data handling leave the list alone', () => {
    const listed = run([{ type: 'listed', models: [{ id: 'x', displayName: null }] }], filled());
    for (const change of [
      edit({ field: 'model', value: 'x' }),
      edit({ field: 'label', value: 'Renamed' }),
      edit({ field: 'baaCovered', value: true }),
    ]) {
      expect(run([change], listed).available).not.toBeNull();
    }
  });
});

describe('Test connection', () => {
  it('needs a model id and a key; says what is missing until it has them', () => {
    const noModel = run([edit({ field: 'apiKey', value: 'sk' })], adding());
    expect(canTest(noModel)).toBe(false);
    expect(formView(noModel).testMissing).toBe(true);
    expect(canTest(run([edit({ field: 'model', value: '  ' })], noModel))).toBe(false);
    expect(canTest(filled())).toBe(true);
    expect(formView(filled()).testMissing).toBe(false);
  });

  it('sends the draft’s own settings, with the typed key', () => {
    const state = filled([
      edit({ field: 'provider', value: 'openai' }),
      edit({ field: 'model', value: 'gpt-6-astra-1' }),
      edit({ field: 'apiKey', value: 'sk-x' }),
      edit({ field: 'apiSurface', value: 'responses' }),
      edit({ field: 'reasoningEffort', value: 'none' }),
      edit({ field: 'baseUrl', value: 'https://res.openai.azure.com/openai/v1' }),
    ]);
    expect(testRequest(state)).toEqual({
      provider: 'openai',
      model: 'gpt-6-astra-1',
      baseUrl: 'https://res.openai.azure.com/openai/v1',
      reasoningEffort: 'none',
      apiSurface: 'responses',
      apiKey: 'sk-x',
    });
  });

  it('a success shows the reply, and an empty reply says so', () => {
    const ok = run([{ type: 'testSent' }, { type: 'tested', reply: 'ok' }], filled());
    expect(ok.testing).toBe(false);
    expect(ok.testReply).toBe('ok');
    expect(run([{ type: 'tested', reply: '' }], filled()).testReply).toBe('(no text in the reply)');
  });

  it('a failure shows the provider’s words and no reply', () => {
    const failed = run(
      [
        { type: 'tested', reply: 'ok' },
        { type: 'testSent' },
        {
          type: 'testFailed',
          error: 'The provider did not understand the request — check the model id and base URL.',
        },
      ],
      filled()
    );
    expect(failed.testReply).toBeNull();
    expect(failed.testError).toBe(
      'The provider did not understand the request — check the model id and base URL.'
    );
    expect(run([{ type: 'testFailed', error: null }], filled()).testError).toBe(
      'Could not reach the provider'
    );
  });

  it('a new attempt clears the last result while it is in flight', () => {
    const state = run([{ type: 'tested', reply: 'ok' }, { type: 'testSent' }], filled());
    expect(state.testing).toBe(true);
    expect(state.testReply).toBeNull();
  });

  it('editing the model id makes a passed test stale', () => {
    const tested = run([{ type: 'tested', reply: 'ok' }], filled());
    const typo = run([edit({ field: 'model', value: 'claude-sonnet-5-typo' })], tested);
    expect(typo.testReply).toBeNull();
  });

  it('changing the reasoning effort or the connection does too, and a failure goes the same way', () => {
    const tested = run([{ type: 'tested', reply: 'ok' }], filled());
    expect(run([edit({ field: 'reasoningEffort', value: 'low' })], tested).testReply).toBeNull();
    expect(run([edit({ field: 'apiKey', value: 'sk-2' })], tested).testReply).toBeNull();
    const failed = run([{ type: 'testFailed', error: 'nope' }], filled());
    expect(run([edit({ field: 'model', value: 'other' })], failed).testError).toBeNull();
  });

  it('picking a different model from the provider’s list makes a passed test stale', () => {
    const tested = run(
      [
        { type: 'listed', models: [{ id: 'claude-opus-5', displayName: null }] },
        { type: 'tested', reply: 'ok' },
      ],
      filled()
    );
    const picked = run([{ type: 'picked', model: 'claude-opus-5' }], tested);
    expect(picked.draft.model).toBe('claude-opus-5');
    expect(picked.testReply).toBeNull();
    // Picking the model already tested keeps the result: it answers for it.
    expect(run([{ type: 'picked', model: 'claude-sonnet-5' }], tested).testReply).toBe('ok');
  });

  it('labels, counts, temperature and data handling leave the result alone', () => {
    const tested = run([{ type: 'tested', reply: 'ok' }], filled());
    for (const change of [
      edit({ field: 'label', value: 'Renamed' }),
      edit({ field: 'contextWindow', value: '1m' }),
      edit({ field: 'temperature', value: '0.5' }),
      edit({ field: 'notes', value: 'n' }),
    ]) {
      expect(run([change], tested).testReply).toBe('ok');
    }
  });
});

describe('the API key', () => {
  it('reuse is offered from every other row that has a key stored', () => {
    const state = run([
      { type: 'loaded', models: [row('a'), row('b', { hasApiKey: false }), row('c')] },
      { type: 'startEdit', row: row('a') },
    ]);
    expect(keyedSiblings(state).map((sibling) => sibling.id)).toEqual(['c']);
  });

  it('choosing a key to reuse hides the key field and drops what was typed', () => {
    const state = run(
      [edit({ field: 'apiKey', value: 'sk-typed' }), edit({ field: 'apiKeyFromId', value: 's' })],
      adding(row('s'))
    );
    expect(state.draft.apiKey).toBe('');
    expect(formView(state).showsKeyInput).toBe(false);
    expect(formView(state).keyRequired).toBe(false);
    expect(bodyOf(state)).toMatchObject({ apiKeyFromId: 's' });
    expect(bodyOf(state)).not.toHaveProperty('apiKey');
    expect(listRequest(state)).toMatchObject({ modelConfigId: 's' });
  });

  it('a blank key on an edit sends no key, so the stored one is kept', () => {
    const stored = row('a');
    const state = run([
      { type: 'loaded', models: [stored] },
      { type: 'startEdit', row: stored },
    ]);
    const body = bodyOf(state);
    expect(body).not.toHaveProperty('apiKey');
    expect(body).not.toHaveProperty('apiKeyFromId');
  });
});

describe('Save', () => {
  it('a new model POSTs everything the form says, trimmed, and nothing left blank', () => {
    const state = filled([
      edit({ field: 'baseUrl', value: '' }),
      edit({ field: 'temperature', value: '0.3' }),
      edit({ field: 'apiVersion', value: ' 2024-05-01-preview ' }),
      edit({ field: 'dataResidency', value: '  Azure East US, DataZone ' }),
      edit({ field: 'providerRetention', value: 'none' }),
      edit({ field: 'baaCovered', value: true }),
      edit({ field: 'notes', value: ' BAA signed 2026-01 ' }),
    ]);
    expect(saveRequest(state)).toEqual({
      ok: true,
      method: 'POST',
      path: '/api/admin/llm-models',
      body: {
        label: 'Prod Claude',
        provider: 'anthropic',
        model: 'claude-sonnet-5',
        baseUrl: null,
        temperature: 0.3,
        apiVersion: '2024-05-01-preview',
        dataResidency: 'Azure East US, DataZone',
        providerRetention: 'none',
        baaCovered: true,
        notes: 'BAA signed 2026-01',
        apiKey: 'sk-ant-key',
        enabled: true,
        isDefault: true,
      },
    });
  });

  it('says outright that there is no BAA, and leaves an unknown retention unsaid', () => {
    const body = bodyOf(filled());
    expect(body.baaCovered).toBe(false);
    expect(body).not.toHaveProperty('providerRetention');
    expect(body).not.toHaveProperty('dataResidency');
    expect(body).not.toHaveProperty('notes');
  });

  it('an edit PUTs to its own row', () => {
    const stored = row('a');
    const state = run([
      { type: 'loaded', models: [stored] },
      { type: 'startEdit', row: stored },
    ]);
    expect(saveRequest(state)).toMatchObject({
      ok: true,
      method: 'PUT',
      path: '/api/admin/llm-models/a',
    });
  });

  it('asks for the organization default when it is ticked, and never for an image model', () => {
    expect(bodyOf(filled([edit({ field: 'isDefault', value: true })], row('x'))).isDefault).toBe(
      true
    );
    expect(bodyOf(filled([], row('x'))).isDefault).toBe(false);
    // A stored row that somehow holds both still saves as a non-default image model.
    const odd = row('i', {
      provider: 'openai',
      isDefault: true,
      settings: { apiSurface: 'images' },
    });
    const state = run([
      { type: 'loaded', models: [odd] },
      { type: 'startEdit', row: odd },
    ]);
    expect(bodyOf(state).isDefault).toBe(false);
    expect(formView(state).defaultBox).toEqual({ checked: false, disabled: true });
  });

  it('a disabled model saves as disabled', () => {
    expect(bodyOf(filled([edit({ field: 'enabled', value: false })])).enabled).toBe(false);
  });

  it('while saving the error clears; a saved model closes the form', () => {
    const sending = run([{ type: 'saveFailed', error: 'earlier' }, { type: 'saveSent' }], filled());
    expect(sending.saving).toBe(true);
    expect(sending.formError).toBeNull();
    const saved = run([{ type: 'saved' }], sending);
    expect(saved.saving).toBe(false);
    expect(saved.editingId).toBeNull();
    expect(saved.draft).toEqual(emptyDraft);
  });

  it('a refused save keeps the form open with the server’s words', () => {
    const refused = run(
      [
        { type: 'saveSent' },
        { type: 'saveFailed', error: 'A model with this label already exists.' },
      ],
      filled()
    );
    expect(refused.saving).toBe(false);
    expect(refused.editingId).toBe('new');
    expect(refused.formError).toBe('A model with this label already exists.');
    expect(refused.draft.label).toBe('Prod Claude');
  });
});
