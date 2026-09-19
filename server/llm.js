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
  // Server-tool turns can stop with `pause_turn`; resume by pushing the paused
  // assistant turn back and calling again.
  for (let i = 0; i < 10; i++) {
    if (signal?.aborted) throw new Error('Cancelled');
    response = await client.messages.create(params, { signal });
    if (response.stop_reason !== 'pause_turn') break;
    params.messages = [...params.messages, { role: 'assistant', content: response.content }];
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
    truncated: response.stop_reason === 'max_tokens',
    usage: {
      input: response.usage.input_tokens,
      output: response.usage.output_tokens,
      cacheRead: response.usage.cache_read_input_tokens ?? 0,
    },
  };
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
