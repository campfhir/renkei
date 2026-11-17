import type { Scenario } from '../../domain';
import type { DataStore } from '../../types';
import { ANN, BOB, CHAT, PROJECT, at, chatWorld, uid } from '../chats/fixtures';

const AGENT = { triage: uid(931), billing: uid(932), bobs: uid(933) };
const RUN = { one: uid(941), two: uid(942), three: uid(943), four: uid(944) };

function agent(id: string, owner: string, name: string) {
  return {
    id,
    owner_subject: owner,
    name,
    instructions: `do ${name}`,
    tools: ['jira_search'],
    enabled: true,
    created_at: at(1),
    updated_at: at(1),
  };
}

function run(id: string, agentId: string, owner: string, minute: number) {
  return { id, agent_id: agentId, owner_subject: owner, trigger_kind: 'chat', created_at: at(minute) };
}

function ask(runId: string, chatId: string, toolUseId: string, agentId: string, minute: number) {
  return {
    run_id: runId,
    chat_id: chatId,
    tool_use_id: toolUseId,
    agent_id: agentId,
    asked_by: ANN,
    created_at: at(minute),
  };
}

const fixture = {
  ...chatWorld(),
  agents: [
    agent(AGENT.triage, ANN, 'triage'),
    agent(AGENT.billing, ANN, 'billing'),
    agent(AGENT.bobs, BOB, 'bobs'),
  ],
  agent_runs: [
    run(RUN.one, AGENT.triage, ANN, 20),
    run(RUN.two, AGENT.billing, ANN, 20),
    run(RUN.three, AGENT.triage, ANN, 30),
    run(RUN.four, AGENT.bobs, BOB, 40),
  ],
  chat_agent_asks: [
    ask(RUN.three, CHAT.annA, 'toolu_c', AGENT.triage, 30),
    ask(RUN.two, CHAT.annA, 'toolu_b', AGENT.billing, 20),
    ask(RUN.one, CHAT.annA, 'toolu_a', AGENT.triage, 20),
  ],
  chat_project_agents: [
    { project_id: PROJECT.annChat, agent_id: AGENT.triage, added_by: ANN, created_at: at(12) },
    { project_id: PROJECT.annChat, agent_id: AGENT.billing, added_by: ANN, created_at: at(11) },
    { project_id: PROJECT.bobChat, agent_id: AGENT.bobs, added_by: BOB, created_at: at(11) },
  ],
};

/** A record without its insert time, which each store stamps from its own clock. */
const timeless = <T extends { createdAt: Date }>(record: T | null) => {
  if (!record) return null;
  const { createdAt: _createdAt, ...rest } = record;
  return rest;
};

export const chatAgentScenarios: Scenario<DataStore>[] = [
  {
    method: 'chatAgents.recordAsk',
    name: 'a recorded ask reads back by run and by call',
    fixture,
    run: async (store) => {
      await store.chatAgents.recordAsk({
        runId: RUN.four,
        chatId: CHAT.annB,
        toolUseId: 'toolu_z',
        agentId: AGENT.bobs,
        askedBy: ANN,
      });
      return [
        timeless(await store.chatAgents.findAskByRun(RUN.four)),
        (await store.chatAgents.listAsks(CHAT.annB)).map(timeless),
      ];
    },
  },
  {
    method: 'chatAgents.listAsks',
    name: 'oldest first, ties by run id; another chat has none',
    fixture,
    run: async (store) => [
      await store.chatAgents.listAsks(CHAT.annA),
      await store.chatAgents.listAsks(CHAT.annB),
    ],
  },
  {
    method: 'chatAgents.findAskByRun',
    name: 'the ask behind a run; a run no chat started has none',
    fixture,
    run: async (store) => [
      await store.chatAgents.findAskByRun(RUN.two),
      await store.chatAgents.findAskByRun(RUN.four),
    ],
  },
  {
    method: 'chatAgents.findAskByCall',
    name: 'by chat and call id; the same call id in another chat is not it',
    fixture,
    run: async (store) => [
      await store.chatAgents.findAskByCall(CHAT.annA, 'toolu_c'),
      await store.chatAgents.findAskByCall(CHAT.annB, 'toolu_c'),
    ],
  },
  {
    method: 'chatAgents.listProjectAgents',
    name: 'in the order added; each project its own',
    fixture,
    run: async (store) => [
      await store.chatAgents.listProjectAgents(PROJECT.annChat),
      await store.chatAgents.listProjectAgents(PROJECT.annCode),
    ],
  },
  {
    method: 'chatAgents.addProjectAgent',
    name: 'added once; a second add is refused and changes nothing',
    fixture,
    run: async (store) => {
      const first = await store.chatAgents.addProjectAgent(PROJECT.annCode, AGENT.triage, ANN);
      const again = await store.chatAgents.addProjectAgent(PROJECT.annChat, AGENT.triage, BOB);
      return {
        first,
        again,
        code: (await store.chatAgents.listProjectAgents(PROJECT.annCode)).map(timeless),
        chat: await store.chatAgents.listProjectAgents(PROJECT.annChat),
      };
    },
  },
  {
    method: 'chatAgents.removeProjectAgent',
    name: 'removed from that project only; removing again says so',
    fixture,
    run: async (store) => [
      await store.chatAgents.removeProjectAgent(PROJECT.annChat, AGENT.billing),
      await store.chatAgents.removeProjectAgent(PROJECT.annChat, AGENT.billing),
      await store.chatAgents.listProjectAgents(PROJECT.annChat),
      await store.chatAgents.listProjectAgents(PROJECT.bobChat),
    ],
  },
];
