import {
  cellsFromNotebookSource,
  itemFolderName,
  itemsDirectory,
  notebookAsSource,
  notebookSourceFromCells,
  platformFile,
  repoFilesForItem,
  repoFilesFromDefinition,
} from './git-format';

const IPYNB = JSON.stringify({
  nbformat: 4,
  metadata: { language_info: { name: 'python' } },
  cells: [
    { cell_type: 'markdown', source: ['# Load orders\n', '\n', 'Bronze to silver.'] },
    { cell_type: 'code', source: ['df = spark.read.table("bronze.orders")\n', 'df.count()'] },
  ],
});

describe('Fabric items as a repository holds them', () => {
  it('names an item’s folder by its display name and type, with unsafe characters replaced', () => {
    expect(itemFolderName('Load orders', 'Notebook')).toBe('Load orders.Notebook');
    expect(itemFolderName('Sales/EU: daily', 'DataPipeline')).toBe('Sales-EU- daily.DataPipeline');
  });

  it('keeps the items directory inside the repository', () => {
    expect(itemsDirectory(undefined)).toBe('fabric');
    expect(itemsDirectory('/workspaces/sales/')).toBe('workspaces/sales');
    expect(itemsDirectory('../elsewhere')).toBeNull();
  });

  it('writes .platform with the type, name and a logical id', () => {
    expect(JSON.parse(platformFile('Notebook', 'Load orders', '', 'id-1'))).toEqual({
      $schema: expect.stringContaining('platformProperties'),
      metadata: { type: 'Notebook', displayName: 'Load orders' },
      config: { version: '2.0', logicalId: 'id-1' },
    });
  });

  it('turns a Jupyter notebook into Fabric’s source format and back to the same cells', () => {
    const converted = notebookAsSource(IPYNB);
    if (typeof converted === 'string') throw new Error(converted);
    expect(converted.source.startsWith('# Fabric notebook source\n')).toBe(true);
    expect(converted.source).toContain(
      '# MARKDOWN ********************\n\n# # Load orders\n#\n# Bronze to silver.'
    );
    expect(converted.source).toContain(
      '# CELL ********************\n\ndf = spark.read.table("bronze.orders")\ndf.count()'
    );
    expect(cellsFromNotebookSource(converted.source)).toEqual([
      { kind: 'markdown', source: '# Load orders\n\nBronze to silver.' },
      { kind: 'code', source: 'df = spark.read.table("bronze.orders")\ndf.count()' },
    ]);
  });

  it('takes a notebook already in Fabric’s source format as it is', () => {
    const source = notebookSourceFromCells([{ kind: 'code', source: 'print(1)' }]);
    const taken = notebookAsSource(source);
    expect(typeof taken !== 'string' && taken.source).toBe(source);
    expect(notebookAsSource('{"cells": 3}')).toMatch(/Jupyter JSON/);
  });

  it('writes a notebook as its source and .platform under the items directory', () => {
    const files = repoFilesForItem(
      {
        type: 'Notebook',
        displayName: 'Load orders',
        description: 'd',
        content: IPYNB,
        logicalId: 'id-1',
      },
      'fabric'
    );
    if (typeof files === 'string') throw new Error(files);
    expect(files.map((f) => f.path)).toEqual([
      'fabric/Load orders.Notebook/notebook-content.py',
      'fabric/Load orders.Notebook/.platform',
    ]);
  });

  it('refuses a pipeline without activities', () => {
    expect(
      repoFilesForItem(
        { type: 'DataPipeline', displayName: 'P', description: '', content: '{}', logicalId: 'x' },
        'fabric'
      )
    ).toMatch(/activities/);
  });

  it('writes an exported definition’s text parts and names what it left out', () => {
    const exported = repoFilesFromDefinition(
      {
        format: null,
        parts: [
          { path: 'notebook-content.py', text: '# Fabric notebook source\n' },
          { path: 'resources/logo.png', base64: 'iVBORw0' },
        ],
      },
      { type: 'Notebook', displayName: 'Load orders', description: '', logicalId: 'id-2' },
      'fabric'
    );
    expect(exported.files.map((f) => f.path)).toEqual([
      'fabric/Load orders.Notebook/notebook-content.py',
      'fabric/Load orders.Notebook/.platform',
    ]);
    expect(exported.skipped).toEqual(['resources/logo.png']);
  });
});
