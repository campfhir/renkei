'use client';

/**
 * The on/off switch for an agent the caller owns (or holds an access grant
 * on) — a self-contained client component so it can drop into any page
 * without that page wiring up the save call itself. Shared by the agents
 * list, the agent overview page, and the edit page.
 *
 * There is no dedicated "toggle" endpoint: it PUTs the same full payload
 * the builder saves, with only `enabled` flipped, through
 * `/api/tenant/{tenantId}/agents/{agentId}`. Every field that route persists
 * has to ride along — omitting one here would make the switch silently wipe
 * it, so this takes a `StoredAgent` and rebuilds the whole payload from it.
 */

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import type { StoredAgent } from '@/lib/agents/store';
import { sendJsonFull } from '@/lib/fetch-json';

function savePayloadOf(agent: StoredAgent, enabled: boolean) {
  return {
    name: agent.name,
    steps: agent.steps,
    triggers: agent.triggers.map((trigger) => ({
      id: trigger.id,
      draft: trigger.draft,
      enabled: trigger.enabled,
    })),
    enabled,
    llmModelId: agent.llmModelId,
    guardrails: agent.guardrails,
    blockedTools: agent.blockedTools,
  };
}

export default function AgentEnabledToggle({
  tenantId,
  agent,
  onError,
}: {
  tenantId: string;
  agent: StoredAgent;
  onError?: (message: string) => void;
}): React.ReactNode {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  const toggle = async () => {
    setBusy(true);
    const result = await sendJsonFull(
      `/api/tenant/${tenantId}/agents/${agent.id}`,
      'PUT',
      savePayloadOf(agent, !agent.enabled)
    );
    setBusy(false);
    if (result.error) onError?.(result.error);
    else router.refresh();
  };

  return (
    <button
      type="button"
      role="switch"
      aria-checked={agent.enabled}
      aria-label={agent.enabled ? 'Turn agent off' : 'Turn agent on'}
      title={agent.enabled ? 'On — click to turn off' : 'Off — click to turn on'}
      disabled={busy}
      onClick={toggle}
      className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors disabled:opacity-50 ${
        agent.enabled ? 'bg-green-500' : 'bg-gray-300 dark:bg-gray-700'
      }`}
    >
      <span
        className={`inline-block transform rounded-full bg-white shadow transition-transform ${
          agent.enabled ? 'translate-x-6' : 'translate-x-1'
        }`}
        style={{ height: '1.125rem', width: '1.125rem' }}
      />
    </button>
  );
}
