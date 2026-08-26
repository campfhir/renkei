import {
  annotateEntries,
  canListFolder,
  effectiveAccess,
  hasAllowedDescendant,
  layerAccess,
} from './acl';
import type { AccessLevel, AclContext, PathRule, RawEntry } from './types';
import { minAccess } from './types';

function context(overrides?: {
  maxAccess?: 'read' | 'read_write';
  defaultAccess?: AccessLevel;
  shareRules?: PathRule[];
  userRules?: PathRule[];
  caseInsensitive?: boolean;
  enabled?: boolean;
  hasCredentials?: boolean;
}): AclContext {
  return {
    share: {
      id: 'share-1',
      name: 'Accounting',
      protocol: 'smb',
      host: 'files.example.test',
      port: null,
      shareName: 'accounting',
      rootPath: '/',
      caseInsensitive: overrides?.caseInsensitive ?? false,
      maxAccess: overrides?.maxAccess ?? 'read_write',
      enabled: overrides?.enabled ?? true,
      hasCredentials: overrides?.hasCredentials ?? true,
    },
    grant: { subject: 'user-1', defaultAccess: overrides?.defaultAccess ?? 'read_write' },
    shareRules: overrides?.shareRules ?? [],
    userRules: overrides?.userRules ?? [],
  };
}

describe('minAccess', () => {
  it('orders none < read < read_write', () => {
    expect(minAccess('read', 'read_write')).toBe('read');
    expect(minAccess('none', 'read_write')).toBe('none');
    expect(minAccess('read_write', 'read_write')).toBe('read_write');
  });
});

describe('layerAccess', () => {
  const rules: PathRule[] = [
    { path: '/finance', access: 'none' },
    { path: '/finance/public', access: 'read' },
    { path: '/finance/public/forms', access: 'read_write' },
  ];

  it('falls back to the layer default with no matching rule', () => {
    expect(layerAccess(rules, '/hr', 'read', false)).toBe('read');
  });

  it('longest matching prefix wins, allow or deny alike', () => {
    expect(layerAccess(rules, '/finance/secret.xlsx', 'read', false)).toBe('none');
    expect(layerAccess(rules, '/finance/public/notice.txt', 'read', false)).toBe('read');
    expect(layerAccess(rules, '/finance/public/forms/w2.pdf', 'read', false)).toBe('read_write');
  });

  it('an exact match is the longest possible prefix', () => {
    expect(layerAccess(rules, '/finance/public', 'read', false)).toBe('read');
  });

  it('under case folding, ambiguous equal-length matches fail closed', () => {
    const ambiguous: PathRule[] = [
      { path: '/Docs', access: 'read_write' },
      { path: '/docs', access: 'read' },
    ];
    expect(layerAccess(ambiguous, '/docs/file', 'read_write', true)).toBe('read');
  });

  it('does not fold case unless asked', () => {
    expect(layerAccess([{ path: '/Docs', access: 'none' }], '/docs/x', 'read', false)).toBe('read');
  });
});

describe('effectiveAccess', () => {
  it('grants the whole tree when no rules exist', () => {
    const ctx = context();
    expect(effectiveAccess(ctx, '/')).toBe('read_write');
    expect(effectiveAccess(ctx, '/any/depth/of/path')).toBe('read_write');
  });

  it('layers compose by minimum — user rules cannot widen the share layer', () => {
    const ctx = context({
      shareRules: [{ path: '/restricted', access: 'none' }],
      userRules: [{ path: '/restricted', access: 'read_write' }],
    });
    expect(effectiveAccess(ctx, '/restricted/file')).toBe('none');
  });

  it('share max_access is a ceiling over everything', () => {
    const ctx = context({
      maxAccess: 'read',
      userRules: [{ path: '/mine', access: 'read_write' }],
    });
    expect(effectiveAccess(ctx, '/mine/doc')).toBe('read');
  });

  it('grant default none with carve-in allows only the carved path', () => {
    const ctx = context({
      defaultAccess: 'none',
      userRules: [{ path: '/projects/renkei', access: 'read' }],
    });
    expect(effectiveAccess(ctx, '/projects/renkei/notes.md')).toBe('read');
    expect(effectiveAccess(ctx, '/projects/other')).toBe('none');
    expect(effectiveAccess(ctx, '/')).toBe('none');
  });

  it('a deeper allow overrides a shallower deny within a layer', () => {
    const ctx = context({
      userRules: [
        { path: '/vault', access: 'none' },
        { path: '/vault/shared', access: 'read' },
      ],
    });
    expect(effectiveAccess(ctx, '/vault/private')).toBe('none');
    expect(effectiveAccess(ctx, '/vault/shared/doc')).toBe('read');
  });

  it('a disabled or credential-less share answers none everywhere', () => {
    expect(effectiveAccess(context({ enabled: false }), '/')).toBe('none');
    expect(effectiveAccess(context({ hasCredentials: false }), '/')).toBe('none');
  });

  it('folds rule case when the share says to', () => {
    const ctx = context({
      caseInsensitive: true,
      userRules: [{ path: '/Reports', access: 'none' }],
    });
    expect(effectiveAccess(ctx, '/reports/q4.xlsx')).toBe('none');
  });
});

describe('hasAllowedDescendant / canListFolder', () => {
  const carveIn = context({
    defaultAccess: 'none',
    userRules: [{ path: '/deep/nested/allowed', access: 'read' }],
  });

  it('detects an exercisable allow strictly below a closed path', () => {
    expect(hasAllowedDescendant(carveIn, '/')).toBe(true);
    expect(hasAllowedDescendant(carveIn, '/deep')).toBe(true);
    expect(hasAllowedDescendant(carveIn, '/deep/nested')).toBe(true);
    expect(hasAllowedDescendant(carveIn, '/deep/nested/allowed')).toBe(false);
    expect(hasAllowedDescendant(carveIn, '/elsewhere')).toBe(false);
  });

  it('ignores allow rules the other layer nullifies', () => {
    const ctx = context({
      defaultAccess: 'none',
      shareRules: [{ path: '/deep', access: 'none' }],
      userRules: [{ path: '/deep/allowed', access: 'read' }],
    });
    expect(hasAllowedDescendant(ctx, '/')).toBe(false);
  });

  it('closed folders on the way to a carve-in stay listable', () => {
    expect(canListFolder(carveIn, '/deep')).toBe(true);
    expect(canListFolder(carveIn, '/elsewhere')).toBe(false);
    expect(canListFolder(carveIn, '/deep/nested/allowed')).toBe(true);
  });
});

describe('annotateEntries', () => {
  const entries: RawEntry[] = [
    { name: 'open.txt', kind: 'file', size: 10, modifiedAt: null },
    { name: 'closed.txt', kind: 'file', size: 10, modifiedAt: null },
    { name: 'closed-dir', kind: 'dir', size: null, modifiedAt: null },
    { name: 'corridor', kind: 'dir', size: null, modifiedAt: null },
    { name: 'writable', kind: 'dir', size: null, modifiedAt: null },
  ];

  const ctx = context({
    maxAccess: 'read_write',
    defaultAccess: 'read',
    userRules: [
      { path: '/closed.txt', access: 'none' },
      { path: '/closed-dir', access: 'none' },
      { path: '/corridor', access: 'none' },
      { path: '/corridor/allowed', access: 'read' },
      { path: '/writable', access: 'read_write' },
    ],
  });

  it('hides closed entries, marks corridors, stamps levels', () => {
    const annotated = annotateEntries(ctx, '/', entries);
    const byName = new Map(annotated.map((entry) => [entry.name, entry]));

    expect(byName.get('open.txt')?.access).toBe('read');
    expect(byName.has('closed.txt')).toBe(false);
    expect(byName.has('closed-dir')).toBe(false);
    expect(byName.get('corridor')?.access).toBe('traverse');
    expect(byName.get('writable')?.access).toBe('read_write');
  });

  it('builds child paths from the listed directory', () => {
    const annotated = annotateEntries(ctx, '/', entries);
    expect(annotated.find((entry) => entry.name === 'open.txt')?.path).toBe('/open.txt');
  });
});
