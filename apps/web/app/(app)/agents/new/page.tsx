import React from 'react';
import { redirect } from 'next/navigation';
import { getSessionFromCookies } from '@/lib/session';
import { signInUrl } from '@/lib/sign-in-url';
import { loadBuilderData } from '@/lib/agents/builder-data';
import { AgentBuilder } from '../builder/agent-builder';

export default async function NewAgentPage(): Promise<React.ReactNode> {
  const session = await getSessionFromCookies();
  if (!session) {
    redirect(signInUrl(`/agents/new`));
  }

  const data = await loadBuilderData(session.subject);

  // No width cap here: the builder manages its own two-column layout.
  return (
    <div>
      <div className="mx-auto mb-6 lg:max-w-3xl">
        <h1 className="mb-1 text-xl font-bold">New agent</h1>
        <p className="text-sm text-gray-600 dark:text-gray-400">
          Tell the agent what to achieve and give it the tools it needs — it works out the steps on
          each run, and every change it wants to make waits for your go-ahead.
        </p>
      </div>
      <AgentBuilder
        tools={data.tools}
        otherAgents={data.otherAgents}
        calendars={data.calendars}
        models={data.models}
        runLimits={data.runLimits}
        actApprovalPolicy={data.actApprovalPolicy}
      />
    </div>
  );
}
