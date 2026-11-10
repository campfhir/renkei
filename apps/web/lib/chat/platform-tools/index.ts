/**
 * The platform tools: what a chat can do in Renkei itself, for the person
 * in it — beside the connectors, which act in the organization's systems.
 * Every chat has them (chat-local-tools.ts), whatever its toolset: they
 * run in-process, as the person the turn runs as, on that person's own
 * things.
 *
 * Two tiers, the way connector tools have (tool-surface.ts):
 *
 * - **Offered on every turn**: a link to anywhere in the app
 *   (navigation.ts), the person's own usage (usage.ts), and reading and
 *   changing their preferences (preferences.ts). Small, and the ones a
 *   person asks for in passing.
 * - **Behind find_tools** (`deferred`): the organization's usage, for
 *   operators; making a chat project or a code project (projects.ts); and
 *   the prompt libraries (prompt-libraries.ts). Their schemas reach the
 *   model only once it searches for them, so a chat about anything else
 *   does not carry them on every request.
 *
 * A tool that could only fail is not built: organization usage without
 * the operator role, a code project without code workspaces and a git
 * host connection that can clone, push and open pull requests.
 */

import { sandboxWorkspacesEnabled } from '@renkei/sandbox-client';
import { codeProjectProviderAccess } from '@/lib/code/access';
import { CODE_HOSTS } from '@/lib/code/create-project';
import type { LocalTool, LocalToolContext } from '../local-tools';
import { navigationTools } from './navigation';
import { preferenceTools } from './preferences';
import { chatProjectTool, codeProjectTool, type CodeHost } from './projects';
import { promptLibraryTools } from './prompt-libraries';
import { isOperator } from './shared';
import { myUsageTool, orgUsageTool } from './usage';

export { PLATFORM_CONNECTOR, PLATFORM_LABEL } from './shared';

/** What decides which platform tools a turn has; read once per turn. */
export interface PlatformToolOptions {
  operator: boolean;
  /** The git hosts this person can make a code project on; empty withholds the tool. */
  codeHosts: readonly CodeHost[];
}

/** The tools for these options — pure, for the turn and for the catalog of names alike. */
export function platformToolsFor(options: PlatformToolOptions): LocalTool[] {
  return [
    ...navigationTools(),
    myUsageTool(),
    ...preferenceTools(),
    ...(options.operator ? [orgUsageTool()] : []),
    chatProjectTool(),
    ...(options.codeHosts.length > 0 ? [codeProjectTool(options.codeHosts)] : []),
    ...promptLibraryTools(),
  ];
}

/**
 * The git hosts this person can make a code project on right now. A read
 * that fails withholds the tool for the turn rather than failing the turn.
 */
export async function codeHostsFor(subject: string): Promise<CodeHost[]> {
  try {
    if (!(await sandboxWorkspacesEnabled())) return [];
    const access = await codeProjectProviderAccess(subject);
    return CODE_HOSTS.filter((host) => access[host.provider]?.ok === true);
  } catch {
    return [];
  }
}

export async function platformTools(
  context: Pick<LocalToolContext, 'subject' | 'roles'>
): Promise<LocalTool[]> {
  return platformToolsFor({
    operator: isOperator(context),
    codeHosts: await codeHostsFor(context.subject),
  });
}
