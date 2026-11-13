/**
 * A provider that makes nothing: sandboxes are entries in a map, each
 * "answering" at an address of its own. For the orchestrator's tests and
 * the orchestrator service's, which exercise the lifecycle rules without
 * an engine; never selected by configuration.
 */

import {
  ProviderError,
  type ProviderSandbox,
  type ProviderSandboxState,
  type SandboxProvider,
  type SandboxSpec,
} from './provider';

interface Machine {
  providerId: string;
  sandboxId: string;
  state: ProviderSandboxState;
  env: Record<string, string>;
  createdAt: Date;
}

export class FakeSandboxProvider implements SandboxProvider {
  readonly name = 'fake';
  readonly machines = new Map<string, Machine>();
  /** Every call made, in order: `create:<sandboxId>`, `suspend:<providerId>`, … */
  readonly calls: string[] = [];
  /** Set to make the next call of that name fail once. */
  failNext: Partial<Record<'create' | 'suspend' | 'resume' | 'destroy' | 'inspect' | 'list', string>> =
    {};
  private made = 0;

  constructor(private readonly now: () => number = Date.now) {}

  private fail(name: keyof FakeSandboxProvider['failNext']): void {
    const message = this.failNext[name];
    if (message === undefined) return;
    delete this.failNext[name];
    throw new ProviderError(message, 500);
  }

  addressOf(providerId: string): string {
    return `http://${providerId}.sandbox.test:8092`;
  }

  private view(machine: Machine): ProviderSandbox {
    return {
      providerId: machine.providerId,
      state: machine.state,
      address: machine.state === 'running' ? this.addressOf(machine.providerId) : null,
      sandboxId: machine.sandboxId,
      createdAt: machine.createdAt,
    };
  }

  async check(): Promise<void> {}

  async create(spec: SandboxSpec): Promise<{ providerId: string }> {
    this.calls.push(`create:${spec.sandboxId}`);
    this.fail('create');
    this.made += 1;
    const providerId = `m${this.made}`;
    this.machines.set(providerId, {
      providerId,
      sandboxId: spec.sandboxId,
      state: 'running',
      env: spec.env,
      createdAt: new Date(this.now()),
    });
    return { providerId };
  }

  async inspect(providerId: string): Promise<ProviderSandbox | null> {
    this.fail('inspect');
    const machine = this.machines.get(providerId);
    return machine ? this.view(machine) : null;
  }

  async suspend(providerId: string): Promise<void> {
    this.calls.push(`suspend:${providerId}`);
    this.fail('suspend');
    const machine = this.machines.get(providerId);
    if (!machine) throw new ProviderError('no such sandbox', 404);
    machine.state = 'suspended';
  }

  async resume(providerId: string): Promise<void> {
    this.calls.push(`resume:${providerId}`);
    this.fail('resume');
    const machine = this.machines.get(providerId);
    if (!machine) throw new ProviderError('no such sandbox', 404);
    machine.state = 'running';
  }

  async destroy(providerId: string): Promise<void> {
    this.calls.push(`destroy:${providerId}`);
    this.fail('destroy');
    this.machines.delete(providerId);
  }

  async list(): Promise<ProviderSandbox[]> {
    this.fail('list');
    return [...this.machines.values()].map((machine) => this.view(machine));
  }
}
