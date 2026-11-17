import {
  DiskImagePreparer,
  diskImagePlanFor,
  ensureDiskImage,
  type DiskImageClient,
  type DiskImageView,
} from './disk-image';

const SHA = '12112db66f6bdd6fd42846039b8b9e9432136eb7';
const plan = diskImagePlanFor('docker.io/acme/renkei-sandbox', SHA);

/** A sandbox group whose images build through the states it is given, one per look. */
function group(images: DiskImageView[] = [], building: string[] = ['Building', 'Ready']) {
  const created: Array<{ base: string; name: string }> = [];
  const progress = new Map<string, string[]>();
  const client: DiskImageClient = {
    list: async () => images.map((image) => ({ ...image })),
    get: async (id) => {
      const image = images.find((candidate) => candidate.id === id);
      if (!image) return null;
      const next = progress.get(id)?.shift();
      if (next) image.state = next;
      return { ...image };
    },
    create: async (base, name) => {
      created.push({ base, name });
      const id = `img-${created.length}`;
      images.push({ id, name, base, state: 'Pending', message: null });
      progress.set(id, [...building]);
      return id;
    },
  };
  return { client, created, images };
}

const quick = { sleep: async () => undefined, pollMs: 1 };

describe('the disk image a build’s sandboxes boot from', () => {
  it('is the repository’s image at the full commit, named for the build', () => {
    expect(plan).toEqual({
      base: `docker.io/acme/renkei-sandbox:${SHA}`,
      name: 'renkei-sandbox-12112db66f6b',
      build: '12112db',
    });
  });

  it('is made when the group has none, and waited for until it is Ready', async () => {
    const { client, created } = group();
    const seen: string[] = [];
    const id = await ensureDiskImage({
      client,
      plan,
      onProgress: ({ state }) => seen.push(state),
      ...quick,
    });
    expect(id).toBe('img-1');
    expect(created).toEqual([{ base: plan.base, name: plan.name }]);
    expect(seen).toEqual(['Creating', 'Building', 'Ready']);
  });

  it('is reused when the group already has it Ready: a restart imports nothing', async () => {
    const { client, created } = group([
      {
        id: 'old',
        name: 'renkei-sandbox-aaaaaaaaaaaa',
        base: 'x:old',
        state: 'Ready',
        message: null,
      },
      { id: 'mine', name: plan.name, base: plan.base, state: 'Ready', message: null },
    ]);
    expect(await ensureDiskImage({ client, plan, ...quick })).toBe('mine');
    expect(created).toEqual([]);
  });

  it('waits for one another start began, rather than building it twice', async () => {
    const { client, created, images } = group([
      { id: 'building', name: plan.name, base: plan.base, state: 'Building', message: null },
    ]);
    let looks = 0;
    const get = client.get.bind(client);
    client.get = async (id) => {
      looks += 1;
      if (looks === 2) images[0]!.state = 'Ready';
      return get(id);
    };
    expect(await ensureDiskImage({ client, plan, ...quick })).toBe('building');
    expect(created).toEqual([]);
  });

  it('builds a new one beside a failed one, and never takes another build’s image for it', async () => {
    const { client, created } = group([
      { id: 'failed', name: plan.name, base: plan.base, state: 'Failed', message: 'pull refused' },
      {
        id: 'other',
        name: 'renkei-sandbox-ffffffffffff',
        base: 'x:other',
        state: 'Ready',
        message: null,
      },
    ]);
    expect(await ensureDiskImage({ client, plan, ...quick })).toBe('img-1');
    expect(created).toHaveLength(1);
  });

  it('says what the platform said when the build fails', async () => {
    const { client, images } = group([], ['Building', 'Failed']);
    const create = client.create.bind(client);
    client.create = async (base, name) => {
      const id = await create(base, name);
      images.find((image) => image.id === id)!.message = 'manifest unknown';
      return id;
    };
    await expect(ensureDiskImage({ client, plan, ...quick })).rejects.toThrow(
      `the disk image for build 12112db could not be built from ${plan.base}: manifest unknown`
    );
  });

  it('gives up on a build that never finishes, and says how far it got', async () => {
    const { client } = group([], Array(100).fill('Building'));
    let t = 0;
    await expect(
      ensureDiskImage({
        client,
        plan,
        timeoutMs: 60_000,
        now: () => t,
        sleep: async (ms) => void (t += ms),
        pollMs: 10_000,
      })
    ).rejects.toThrow('was still Building after 1 minutes');
  });
});

describe('preparing it once', () => {
  it('joins a preparation already running, and reports where it is', async () => {
    const preparer = new DiskImagePreparer();
    let finish: (id: string) => void = () => undefined;
    let runs = 0;
    const run = (onProgress?: (p: { id: string | null; state: string }) => void) => {
      runs += 1;
      onProgress?.({ id: 'img-1', state: 'Building' });
      return new Promise<string>((resolve) => {
        finish = resolve;
      });
    };
    const first = preparer.prepare('group/build', plan, run);
    const second = preparer.prepare('group/build', plan, run);
    expect(runs).toBe(1);
    expect(preparer.status('group/build')).toEqual({
      build: '12112db',
      base: plan.base,
      state: 'preparing',
      diskImageId: 'img-1',
      detail: 'Building',
    });
    finish('img-1');
    expect(await first).toBe('img-1');
    expect(await second).toBe('img-1');
    expect(preparer.status('group/build')?.state).toBe('ready');
    // Ready is answered at once from then on.
    expect(await preparer.prepare('group/build', plan, run)).toBe('img-1');
    expect(runs).toBe(1);
  });

  it('keeps a failure until it is asked to try again', async () => {
    const preparer = new DiskImagePreparer();
    let attempt = 0;
    const run = async () => {
      attempt += 1;
      if (attempt === 1) throw new Error('pull refused');
      return 'img-2';
    };
    await expect(preparer.prepare('k', plan, run)).rejects.toThrow('pull refused');
    expect(preparer.status('k')).toMatchObject({ state: 'failed', detail: 'pull refused' });
    await expect(preparer.prepare('k', plan, run)).rejects.toThrow('pull refused');
    expect(attempt).toBe(1);
    expect(await preparer.prepare('k', plan, run, { again: true })).toBe('img-2');
    expect(preparer.status('k')).toMatchObject({ state: 'ready', diskImageId: 'img-2' });
  });

  it('says nothing of a group and build no one asked for', () => {
    expect(new DiskImagePreparer().status('never')).toBeNull();
  });
});
