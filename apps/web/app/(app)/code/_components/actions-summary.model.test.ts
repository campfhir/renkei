import { summaryFacts } from './actions-summary.model';

describe('the Actions card’s facts', () => {
  it('counts workflow files and variables, with environments when there are some', () => {
    expect(
      summaryFacts({ workflowCount: 2, variableCount: 5, environmentCount: 1 }, 'main')
    ).toEqual(['2 workflow files on main', '5 variables across the repository and 1 environment']);
  });

  it('says so when there are no workflow files yet, and names the default branch', () => {
    expect(summaryFacts({ workflowCount: 0, variableCount: 1, environmentCount: 0 }, '')).toEqual([
      'no workflow files on the default branch yet',
      '1 variable',
    ]);
  });

  it('leaves out what could not be read', () => {
    expect(
      summaryFacts({ workflowCount: null, variableCount: null, environmentCount: 0 }, 'main')
    ).toEqual(['workflows not checked']);
  });
});
