import React from 'react';
import { redirect } from 'next/navigation';
import { getOrgSettings } from '@renkei/settings';
import { getHighRiskPrefs } from '@renkei/user-prefs';
import { getSessionFromCookies } from '@/lib/session';
import { signInUrl } from '@/lib/sign-in-url';
import { listChatConnectors } from '@/lib/chat/tool-surface';
import { getDefaultChatTools } from '@/lib/chat/tool-prefs';
import { CODE_PROJECT_CONNECTORS, CODE_PROJECT_DEFAULT_CONNECTORS } from '@/lib/chat/tool-config';
import { listHighRiskToolGroups } from '@/lib/chat/permission-catalog';
import { PreferencesSectionBody } from '../section-body';
import DefaultToolsForm from '../default-tools-form';
import HighRiskForm from '../high-risk-form';
import { chatToolOptions } from '../tool-options';

/** Preferences › Code projects: the tools a code chat starts with, and what Auto mode still asks about. */
export default async function CodePreferencesPage(): Promise<React.ReactNode> {
  const session = await getSessionFromCookies();
  if (!session) redirect(signInUrl(`/preferences/code`));
  const [chatConnectors, codeDefault, prefs, groups, org] = await Promise.all([
    listChatConnectors(session.subject),
    getDefaultChatTools(session.subject, { fresh: true, kind: 'code' }),
    getHighRiskPrefs(session.subject, 'code', { fresh: true }),
    listHighRiskToolGroups(session.subject, session.roles, 'code'),
    getOrgSettings(),
  ]);
  return (
    <PreferencesSectionBody
      title="Code projects"
      description="The tools a code chat starts with, and what still stops and asks in Auto mode."
    >
      <DefaultToolsForm
        connectors={chatToolOptions(chatConnectors)}
        initialDefault={codeDefault?.connectors ?? null}
        kind="code"
        baseline={CODE_PROJECT_DEFAULT_CONNECTORS}
        locked={CODE_PROJECT_CONNECTORS}
      />
      <HighRiskForm
        kind="code"
        groups={groups}
        locked={org.ok ? org.val.lockedHighRiskTools : []}
        initial={prefs}
      />
    </PreferencesSectionBody>
  );
}
