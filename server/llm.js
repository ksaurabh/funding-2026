import Anthropic from '@anthropic-ai/sdk';

const EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);

export function makeClient(apiKey) {
  if (!apiKey) throw new Error('No Anthropic API key configured. Set one on the Settings page.');
  return new Anthropic({ apiKey });
}

/**
 * One "ask an LLM" step. `messages` is the running thread; the assistant reply
 * is appended to it so later steps in a conversation-mode playbook see it.
 * Returns { text, citations, usage }.
 */
export async function askLLM(client, { system, messages, settings, webSearch, signal }) {
  const tools = webSearch
    ? [{ type: 'web_search_20260209', name: 'web_search', max_uses: 8 }]
    : undefined;

  const params = {
    model: settings.model,
    max_tokens: settings.maxTokens,
    system,
    messages,
    thinking: { type: 'adaptive' },
    output_config: { effort: EFFORTS.has(settings.effort) ? settings.effort : 'high' },
    ...(tools ? { tools } : {}),
  };

  let response;
  let resumes = 0;
  // Everything the model pulled in on its own during this turn. These results
  // are what inflate input_tokens far beyond the prompt we wrote.
  const searches = [];

  // Server-tool turns can stop with `pause_turn`; resume by pushing the paused
  // assistant turn back and calling again.
  for (let i = 0; i < 10; i++) {
    if (signal?.aborted) throw new Error('Cancelled');
    response = await client.messages.create(params, { signal });
    collectSearches(response.content, searches);
    if (response.stop_reason !== 'pause_turn') break;
    params.messages = [...params.messages, { role: 'assistant', content: response.content }];
    resumes++;
  }

  if (response.stop_reason === 'refusal') {
    throw new Error(
      'The model declined this request' +
        (response.stop_details?.explanation ? `: ${response.stop_details.explanation}` : '.')
    );
  }

  const text = response.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();

  const citations = [];
  for (const block of response.content) {
    if (block.type !== 'web_search_tool_result') continue;
    // On error, `content` is a single object rather than a list of results.
    if (!Array.isArray(block.content)) continue;
    for (const r of block.content) {
      if (r.type === 'web_search_result') citations.push({ title: r.title, url: r.url });
    }
  }

  // Keep the thread going for conversation-mode playbooks. Only the text is
  // replayed: thinking blocks and server-tool blocks aren't needed downstream.
  messages.push({ role: 'assistant', content: text || '(empty response)' });

  return {
    text,
    citations,
    searches,
    resumes,
    truncated: response.stop_reason === 'max_tokens',
    usage: {
      input: response.usage.input_tokens,
      output: response.usage.output_tokens,
      cacheRead: response.usage.cache_read_input_tokens ?? 0,
    },
  };
}

/** Pair each web search the model ran with the results it got back. */
function collectSearches(content, searches) {
  const pending = new Map();
  for (const block of content) {
    if (block.type === 'server_tool_use' && block.name === 'web_search') {
      pending.set(block.id, block.input?.query ?? '');
    }
    if (block.type !== 'web_search_tool_result') continue;
    const query = pending.get(block.tool_use_id) ?? '';
    if (!Array.isArray(block.content)) {
      searches.push({ query, error: block.content?.error_code || 'failed', results: 0, chars: 0 });
      continue;
    }
    searches.push({
      query,
      results: block.content.length,
      // The page text itself comes back opaque, so measure the block instead:
      // a fair proxy for how much reading this search added to the turn.
      chars: JSON.stringify(block.content).length,
      sources: block.content.map((r) => ({ title: r.title, url: r.url })),
    });
  }
}

/**
 * Pick one of `values` for a column, given the thread the step just produced.
 * A JSON-schema output format constrains the reply, so the result is always
 * one of the allowed values (or the call fails).
 */
export async function chooseValue(client, { system, messages, settings, column, values, signal }) {
  const response = await client.messages.create(
    {
      model: settings.model,
      max_tokens: 2000,
      system,
      messages: [
        ...messages,
        {
          role: 'user',
          content:
            `Based on your answer above, choose the single best value for the "${column}" column.\n` +
            `Allowed values: ${values.join(' | ')}\n` +
            'You must pick one of them, even if the fit is imperfect.',
        },
      ],
      thinking: { type: 'adaptive' },
      output_config: {
        effort: 'low',
        format: {
          type: 'json_schema',
          schema: {
            type: 'object',
            properties: { value: { type: 'string', enum: values } },
            required: ['value'],
            additionalProperties: false,
          },
        },
      },
    },
    { signal }
  );

  const text = response.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('');
  let value;
  try {
    value = JSON.parse(text).value;
  } catch {
    throw new Error(`Could not read a value for "${column}" from the model.`);
  }
  if (!values.includes(value)) throw new Error(`Model returned "${value}", which is not an allowed value.`);
  return {
    value,
    usage: {
      input: response.usage.input_tokens,
      output: response.usage.output_tokens,
      cacheRead: response.usage.cache_read_input_tokens ?? 0,
    },
  };
}
