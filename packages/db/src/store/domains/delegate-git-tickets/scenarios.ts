import type { Scenario } from '../../domain';
import type { DataStore } from '../../types';

const id = (n: number) => `00000000-0000-4000-8000-16${String(n).padStart(10, '0')}`;
const at = (minute: number) => new Date(Date.UTC(2026, 0, 1, 0, minute));

const fixture = {
  delegate_git_tickets: [
    {
      id: id(1),
      subject: 'ann',
      provider: 'github',
      host: 'github.com',
      write: true,
      secret_hash: 'h1',
      expires_at: at(10),
    },
    {
      id: id(2),
      subject: 'bob',
      provider: 'bitbucket',
      host: 'bitbucket.org',
      secret_hash: 'h2',
      expires_at: at(30),
    },
  ],
};

export const delegateGitTicketScenarios: Scenario<DataStore>[] = [
  {
    method: 'delegateGitTickets.find',
    name: 'by id as stored (write defaults false); unknown is null',
    fixture,
    run: async (store) => [
      await store.delegateGitTickets.find(id(1)),
      await store.delegateGitTickets.find(id(2)),
      await store.delegateGitTickets.find(id(3)),
    ],
  },
  {
    method: 'delegateGitTickets.insert',
    name: 'reads back',
    fixture,
    run: async (store) => {
      const ticket = {
        id: id(5),
        subject: 'cy',
        provider: 'github',
        host: 'github.com',
        write: false,
        secretHash: 'h5',
        expiresAt: at(20),
      };
      await store.delegateGitTickets.insert(ticket);
      return [await store.delegateGitTickets.find(id(5))];
    },
  },
  {
    method: 'delegateGitTickets.deleteExpired',
    name: 'strictly before the cut only',
    fixture,
    run: async (store) => [
      await store.delegateGitTickets.deleteExpired(at(10)),
      await store.delegateGitTickets.deleteExpired(at(11)),
      await store.delegateGitTickets.find(id(1)),
      await store.delegateGitTickets.find(id(2)),
    ],
  },
];
