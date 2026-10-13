import { useMemo } from 'react';
import { useMutateAction } from '@uibakery/data';
import anthropicMessages from '@/actions/assistant/anthropicMessages';

/**
 * Transport for the read-only assistant: every call executes on UI
 * Bakery's BACKEND through the 'Anthropic API' HTTP datasource, which
 * holds the API key (see src/actions/assistant/DATASOURCE.md). All
 * request shaping, tool dispatch and response parsing live in
 * src/lib/assistant.ts — this hook only supplies the wire.
 */
export type AssistantHttp = {
  messages: (body: unknown) => Promise<unknown>;
};

export function useAssistantHttp(): AssistantHttp {
  const [doPost] = useMutateAction(anthropicMessages);
  return useMemo(() => ({
    messages: (body: unknown) => doPost({ body: JSON.stringify(body) }),
  }), [doPost]);
}
