'use client';

/**
 * A chat project's team (project-team.model.ts): the agents its chats
 * offer first. Editors add their own agents (or ones shared with them)
 * and take any off; members see who is on it and whether they can ask.
 */

import Link from 'next/link';
import { useEffect, useReducer } from 'react';
import { Icon, ICONS } from '@/components/icons';
import { chatClient } from '@/lib/chat/client';
import {
  addableAgents,
  emptyTeamText,
  initialProjectTeam,
  memberNote,
  projectTeamReducer,
} from './project-team.model';

export default function ProjectTeamCard({
  className,
  projectId,
  canEdit,
}: {
  className: string;
  projectId: string;
  canEdit: boolean;
}) {
  const [state, dispatch] = useReducer(projectTeamReducer, initialProjectTeam);
  useEffect(() => {
    void chatClient.projectTeam(projectId).then((result) => {
      dispatch({ type: 'teamLoaded', team: result.data?.team ?? [] });
    });
  }, [projectId]);
  useEffect(() => {
    if (!state.picking || state.candidates) return;
    void chatClient.askableAgents(null).then((result) => {
      dispatch({ type: 'candidatesLoaded', agents: result.data?.agents ?? [] });
    });
  }, [state.picking, state.candidates]);

  const add = async (agentId: string) => {
    dispatch({ type: 'changePressed', agentId });
    const result = await chatClient.addToProjectTeam(projectId, agentId);
    if (result.data?.team && !result.error) dispatch({ type: 'changed', team: result.data.team });
    else dispatch({ type: 'refused', message: result.error ?? 'The agent was not added.' });
  };
  const remove = async (agentId: string) => {
    dispatch({ type: 'changePressed', agentId });
    const result = await chatClient.removeFromProjectTeam(projectId, agentId);
    if (result.data?.team && !result.error) dispatch({ type: 'changed', team: result.data.team });
    else dispatch({ type: 'refused', message: result.error ?? 'The agent was not taken off.' });
  };

  const addable = addableAgents(state);
  return (
    <section className={className} aria-labelledby="project-team-heading" data-project-team>
      <div className="mb-2 flex items-center gap-2">
        <h2 id="project-team-heading" className="flex-1 text-sm font-semibold">
          Team
        </h2>
        {canEdit ? (
          <button
            type="button"
            onClick={() => dispatch({ type: 'pickerToggled' })}
            aria-expanded={state.picking}
            className="flex items-center gap-1 rounded-md border border-gray-300 px-2 py-0.5 text-xs hover:bg-gray-100 dark:border-gray-700 dark:hover:bg-gray-900"
          >
            <Icon path={ICONS.plus} className="h-3.5 w-3.5" />
            Add an agent
          </button>
        ) : null}
      </div>
      {state.picking ? (
        <div className="mb-3 rounded-md border border-gray-200 p-2 dark:border-gray-800">
          {state.candidates === null ? (
            <p className="text-xs text-gray-500">Loading your agents…</p>
          ) : addable.length === 0 ? (
            <p className="text-xs text-gray-500">
              {state.candidates.length === 0 ? (
                <>
                  You have no agents to add yet.{' '}
                  <Link href="/agents/new" className="text-indigo-600 hover:underline dark:text-indigo-400">
                    Make one
                  </Link>
                  .
                </>
              ) : (
                'Every agent you can ask is already on this team.'
              )}
            </p>
          ) : (
            <ul className="space-y-1" aria-label="Agents you can add">
              {addable.map((agent) => (
                <li key={agent.id} className="flex items-center gap-2 text-sm">
                  <Icon path={ICONS.agent} className="h-4 w-4 shrink-0 text-indigo-500" />
                  <span className="min-w-0 flex-1 truncate">{agent.name}</span>
                  <button
                    type="button"
                    onClick={() => void add(agent.id)}
                    disabled={state.busy !== null}
                    aria-label={`Add ${agent.name} to the team`}
                    className="rounded-md px-2 py-0.5 text-xs text-indigo-700 hover:bg-indigo-50 disabled:opacity-50 dark:text-indigo-300 dark:hover:bg-indigo-950/40"
                  >
                    Add
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
      {state.error ? (
        <p role="alert" className="mb-2 text-xs text-red-600 dark:text-red-400">
          {state.error}
        </p>
      ) : null}
      {state.team === null ? null : state.team.length === 0 ? (
        <p className="text-sm text-gray-500">{emptyTeamText(canEdit)}</p>
      ) : (
        <ul className="space-y-2" aria-label="Agents on this project">
          {state.team.map((member) => (
            <li key={member.agentId} className="flex items-start gap-2 text-sm">
              <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-indigo-100 text-indigo-600 dark:bg-indigo-900/60 dark:text-indigo-300">
                <Icon path={ICONS.agent} className="h-3.5 w-3.5" />
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate font-medium">{member.name}</p>
                <p className="text-xs text-gray-500">{memberNote(member)}</p>
                {member.description ? (
                  <p className="mt-0.5 line-clamp-2 text-xs text-gray-600 dark:text-gray-400">
                    {member.description}
                  </p>
                ) : null}
              </div>
              {canEdit ? (
                <button
                  type="button"
                  onClick={() => void remove(member.agentId)}
                  disabled={state.busy !== null}
                  aria-label={`Take ${member.name} off the team`}
                  title="Take off the team"
                  className="rounded-md p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-700 disabled:opacity-50 dark:hover:bg-gray-800 dark:hover:text-gray-200"
                >
                  <Icon path={ICONS.close} className="h-3.5 w-3.5" />
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
