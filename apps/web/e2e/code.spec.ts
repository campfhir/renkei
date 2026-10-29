/**
 * The Code section from a person's side: the index and the menu, a
 * project page before and after its checkout exists (with its README
 * from Bitbucket, its tree, the developer's brief kept on Save, the
 * environment replaced and pruned), a chat in it (back link, Add files
 * into the checkout, Changes with its diff, Environment), a new project
 * made through the form with the repository browsed on Bitbucket, and
 * deletion. The sandbox worker AND Bitbucket are the stub in
 * sandbox-stub.mjs (the app is pointed at it for both), so nothing here
 * needs the network. Screenshots land under
 * test-results/screens/<project>/code-*.png for the eye.
 *
 * Everything is the test's own person's, made the way a person makes it
 * (e2e/support/code-host.ts): Bitbucket connected through the real
 * connect flow, the project and its chat through the Code routes, and the
 * checkout cloned by the chat's first turn — whose stand-in model
 * (e2e/llm-stub.mjs) deletes a file and commits, the steps the transcript
 * shows. desktop-dark runs the old `mobile` project's paths at phone width.
 */

import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { devices, type Browser, type Page, type TestInfo } from '@playwright/test';
import { test, expect } from './fixtures';
import { MEMORY_BASE_URL } from './constants';
import { signIn, type Person } from './support/person';
import { toolStep, removeModel, scripted } from './support/stub-model';
import { askAndWait, setUpCode, stageCodeProject } from './support/code-host';

// The stand-in model is staged by an operator.
test.use({ roles: ['renkei-user', 'renkei-operator'] });

const MOBILE_VIEWPORT = { width: 390, height: 844 };

/** The question the chat is asked, and what its (scripted) model does about it. */
const QUESTION = 'Why does the invoice job retry forever?';
const DELETED = 'src/index.ts';
const TURN = scripted(QUESTION, [
  toolStep('code_delete_file', { path: DELETED }),
  toolStep('code_git_commit', {
    message: 'Cap invoice retries at MAX_ATTEMPTS',
    newBranch: 'fix/retry-cap',
  }),
]);

interface Ids {
  seededProjectId: string;
  seededChatId: string;
  seededName: string;
  seededChatTitle: string;
  newName: string;
  createdRepoName: string;
  createdRepoSlug: string;
  modelId: string;
}

/**
 * The person's code project with no checkout yet (no instructions of its
 * own, so the page offers the developer's brief) and a chat in it that
 * has not run.
 */
async function stage(
  page: Page,
  request: import('@playwright/test').APIRequestContext,
  testInfo: TestInfo
): Promise<Ids> {
  const tag = `${testInfo.project.name}-${randomUUID().slice(0, 6)}`;
  const modelId = await setUpCode(page, request, tag);
  const names = {
    seededName: `Billing service (${tag})`,
    seededChatTitle: `Why does the invoice job retry? (${tag})`,
    newName: `Notifications gateway (${tag})`,
    // A repository created on the fly, through the "Create new repository"
    // tab — its own project so it never collides with the browsed-repo one.
    createdRepoName: `Analytics pipeline (${tag})`,
    createdRepoSlug: `analytics-pipeline-${tag}`,
  };
  const { projectId, chatIds } = await stageCodeProject(page.request, {
    name: names.seededName,
    description: 'Invoices, dunning and the nightly jobs.',
    instructions: '',
    repository: 'acme/billing-service',
    branch: 'main',
    chats: [names.seededChatTitle],
    llmModelId: modelId,
  });
  return { ...names, seededProjectId: projectId, seededChatId: chatIds[0], modelId };
}

/** The page never scrolls sideways — the mobile project is where it would. */
async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth
  );
  expect(overflow).toBeLessThanOrEqual(0);
}

/**
 * The person's page on a phone (a Chromium device: touch, a phone's
 * viewport and user agent), in a context of its own, signed in as them.
 */
async function phonePage(browser: Browser, person: Person): Promise<Page> {
  const context = await browser.newContext({ ...devices['Pixel 7'], baseURL: MEMORY_BASE_URL });
  await signIn(context, person);
  return context.newPage();
}

/**
 * The chat's first turn: the clone, then — unless `plain` — the model's
 * delete and commit.
 */
async function runFirstTurn(page: Page, ids: Ids, plain = false): Promise<void> {
  await askAndWait(page.request, ids.seededChatId, {
    text: plain ? QUESTION : TURN,
    llmModelId: ids.modelId,
  });
}

test.describe('code projects', () => {
  let ids: Ids;
  test.beforeEach(async ({ page, request, person: _person }, testInfo) => {
    test.setTimeout(240_000);
    ids = await stage(page, request, testInfo);
    if (testInfo.project.name === 'desktop-dark') await page.setViewportSize(MOBILE_VIEWPORT);
  });
  test.afterEach(async ({ page }) => {
    await removeModel(page.request, ids.modelId);
  });

  test('index, menu, new project, project page, chat, delete', async ({ page }, testInfo) => {
    // The phone the old `mobile` project was, as a resized viewport.
    const mobile = testInfo.project.name === 'desktop-dark';
    const shot = (name: string) =>
      page.screenshot({
        path: path.join(
          import.meta.dirname,
          '..',
          'test-results',
          'screens',
          testInfo.project.name,
          name
        ),
        fullPage: false,
      });
    const menu = page.getByRole('navigation', { name: 'Application' });
    // The menu lists the same project and chat; the page's own column is
    // what these steps look at.
    const main = page.getByRole('main');
    const openMenu = async () => {
      if (mobile) await page.getByRole('button', { name: 'Open menu' }).click();
    };
    const sectionOf = (name: string) =>
      main.locator('section', { has: page.getByRole('heading', { level: 2, name }) });

    // ── The index: the seeded project under Mine, its repository beneath ──
    await page.goto(`/code`);
    await expect(page.getByRole('heading', { level: 1, name: 'Code' })).toBeVisible();
    const seededRow = main.getByRole('link', { name: ids.seededName });
    await expect(seededRow).toBeVisible();
    await expect(seededRow).toContainText('acme/billing-service');
    await expect(page.getByRole('link', { name: 'New code project' }).first()).toBeVisible();
    await expectNoHorizontalOverflow(page);
    await shot('code-index.png');

    // ── The seeded project's page: not cloned yet (the first chat does
    //    that), the repository fixed — no clone or change buttons — and
    //    the README from Bitbucket in place of a description ──
    await seededRow.click();
    // First hit on a project page in this test: dev-mode's on-demand
    // compile can outrun the default assertion timeout.
    await expect(page.getByRole('heading', { level: 1, name: ids.seededName })).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.getByText('Your code project')).toBeVisible();
    // A code project keeps no files of its own, has a toolset of its own
    // (the picker in its header, which its chats start from), and
    // describes itself through its README; its chats are listed here.
    await expect(main.getByRole('button', { name: 'Add files' })).toHaveCount(0);
    await expect(main.getByRole('button', { name: 'Tools' })).toBeVisible();
    await expect(main.getByLabel('Description')).toHaveCount(0);
    await expect(
      main.getByRole('heading', { level: 2, name: 'Chats in this project' })
    ).toBeVisible();
    await expect(main.getByRole('link', { name: ids.seededChatTitle })).toBeVisible();
    const readme = sectionOf('README');
    await expect(readme.getByRole('heading', { name: 'Billing service' })).toBeVisible();
    await expect(readme.getByRole('heading', { name: 'Running it' })).toBeVisible();
    // Laid out by how often each part is touched: the repository strip
    // first, then the chats — what the page is opened for — then the rail
    // (pulls, commits, CI, services, environment last), then the README,
    // About, Memory. On a wide screen the rail sits beside the chats; on
    // a phone it follows them in one stack.
    const headings = await main.getByRole('heading', { level: 2 }).allTextContents();
    const at = (name: string) => headings.findIndex((text) => text.startsWith(name));
    expect(at('Chats in this project')).toBeGreaterThan(at('Repository'));
    expect(at('Pull requests')).toBeGreaterThan(at('Chats in this project'));
    expect(at('Environment')).toBeGreaterThan(at('Pull requests'));
    expect(at('README')).toBeGreaterThan(at('Environment'));
    expect(at('About')).toBeGreaterThan(at('README'));
    const rail = main.getByRole('complementary', { name: 'Repository activity' });
    const chatsBox = (await main
      .locator('section', {
        has: page.getByRole('heading', { level: 2, name: 'Chats in this project' }),
      })
      .boundingBox())!;
    const railBox = (await rail.boundingBox())!;
    if (!mobile) {
      expect(railBox.x).toBeGreaterThan(chatsBox.x + chatsBox.width - 1);
      expect(Math.abs(railBox.y - chatsBox.y)).toBeLessThan(2);
      // At phone width the same page is one stack, rail after the chats.
      const wide = page.viewportSize()!;
      await page.setViewportSize({ width: 390, height: 844 });
      const narrowChats = (await main
        .locator('section', {
          has: page.getByRole('heading', { level: 2, name: 'Chats in this project' }),
        })
        .boundingBox())!;
      const narrowRail = (await rail.boundingBox())!;
      expect(narrowRail.y).toBeGreaterThan(narrowChats.y + narrowChats.height - 1);
      await expectNoHorizontalOverflow(page);
      await shot('code-project-phone.png');
      await page.setViewportSize(wide);
    } else {
      expect(railBox.y).toBeGreaterThan(chatsBox.y + chatsBox.height - 1);
    }
    // The README opens as a preview and reads in full on request.
    const readmeBody = readme.getByTestId('project-readme-body');
    await expect(readmeBody).not.toHaveAttribute('data-expanded', 'true');
    await readme.getByRole('button', { name: 'Read more' }).click();
    await expect(readmeBody).toHaveAttribute('data-expanded', 'true');
    await readme.getByRole('button', { name: 'Show less' }).click();
    await readme.getByRole('heading', { level: 2, name: 'README' }).click();
    await expect(readme.getByRole('heading', { name: 'Running it' })).toBeHidden();
    await expect(readme.getByRole('heading', { level: 2, name: 'README' })).toBeVisible();
    await shot('code-project-readme-folded.png');
    await readme.getByRole('heading', { level: 2, name: 'README' }).click();
    await expect(readme.getByRole('heading', { name: 'Running it' })).toBeVisible();
    // A subheading sits under its title, not beside it.
    const memoryTitle = main.getByRole('heading', { level: 2, name: 'Memory' });
    const memoryNote = main.getByText("Notes the assistant keeps across this project's chats.");
    expect((await memoryNote.boundingBox())!.y).toBeGreaterThan(
      (await memoryTitle.boundingBox())!.y + 10
    );
    const repository = sectionOf('Repository');
    await expect(repository.getByText('Not cloned yet')).toBeVisible();
    await expect(repository.getByText('acme/billing-service')).toBeVisible();
    await expect(repository.getByText(/The first chat in this project clones it/)).toBeVisible();
    await expect(repository.getByRole('button')).toHaveCount(0);
    await expect(repository.getByRole('link', { name: 'Open on Bitbucket' })).toHaveAttribute(
      'href',
      'https://bitbucket.org/acme/billing-service'
    );
    // The project screen carries no file browser — that lives in the code
    // pane beside a chat (see 'the code pane: read, edit, save, commit and
    // push beside the chat', below).
    await expect(main.getByRole('tree', { name: 'Files' })).toHaveCount(0);
    await expectNoHorizontalOverflow(page);
    await shot('code-project-not-cloned.png');

    // ── Back to Code, and in again ──
    await main.getByRole('link', { name: 'Back to Code' }).click();
    await expect(page).toHaveURL(new RegExp(`/code$`));
    await seededRow.click();
    await expect(page.getByRole('heading', { level: 1, name: ids.seededName })).toBeVisible();

    // ── With a checkout, as the chat's first turn leaves it: Ready ──
    await runFirstTurn(page, ids);
    await page.reload();
    await expect(repository.getByText('Ready')).toBeVisible();
    await expect(repository.getByText(/4\.1 MB on the sandbox/)).toBeVisible();
    await shot('code-project-ready.png');

    // ── The menu (a chat is listed there once it has started): Code sits in the Chat section beside Projects, with no
    //    "+" of its own — the Code page's button makes projects, and the
    //    projects are listed there, not here. The chat inside one IS among
    //    the person's chats, marked as a code chat and naming its project
    //    beneath its title ──
    await openMenu();
    const codeEntry = menu.getByRole('link', { name: 'Code', exact: true });
    await expect(codeEntry).toBeVisible();
    await expect(codeEntry.locator('svg')).toHaveCount(1);
    await expect(menu.getByRole('link', { name: 'Projects', exact: true })).toBeVisible();
    await expect(menu.getByRole('link', { name: 'New code project' })).toHaveCount(0);
    await expect(menu.getByRole('link', { name: ids.seededName, exact: true })).toHaveCount(0);
    const chatRow = menu.getByRole('link', { name: ids.seededChatTitle });
    await expect(chatRow).toBeVisible();
    await expect(chatRow.locator('[data-kind="code"]')).toHaveCount(1);
    await expect(chatRow.getByText(ids.seededName)).toBeVisible();
    if (!mobile) await shot('code-menu.png');
    if (mobile) await page.getByRole('button', { name: 'Close menu' }).click();

    // ── Instructions: a project made without any shows the developer's
    //    brief, unsaved until Save; then it is the project's own ──
    const about = sectionOf('About');
    await expect(about.getByLabel(/^Instructions/)).toHaveValue(/test-first/);
    await expect(about.getByText(/not saved yet/)).toBeVisible();
    // A save re-renders the whole project page: room for a busy dev server.
    await about.getByRole('button', { name: 'Save' }).click();
    await expect(about.getByText('Saved.')).toBeVisible({ timeout: 30_000 });
    await page.reload();
    await expect(sectionOf('About').getByLabel(/^Instructions/)).toHaveValue(/test-first/);
    await expect(sectionOf('About').getByText(/not saved yet/)).toHaveCount(0);

    // ── Environment: none yet; paste a .env with one bad line; names appear,
    //    the bad line is reported, a value is never rendered ──
    const environment = sectionOf('Environment');
    await expect(environment.getByText('No environment variables.')).toBeVisible();
    await environment.getByRole('button', { name: 'Add .env' }).click();
    await environment
      .getByLabel('.env contents')
      .fill(
        'NPM_TOKEN=npm_secret_value_123\nDATABASE_URL=postgres://u:p@db/app\nexport DEBUG=1\nthis line is broken\n'
      );
    await environment.getByRole('button', { name: 'Save' }).click();
    await expect(environment.getByText('NPM_TOKEN')).toBeVisible();
    await expect(environment.getByText('DATABASE_URL')).toBeVisible();
    await expect(environment.getByText('DEBUG')).toBeVisible();
    await expect(environment.getByText(/Not read from the pasted \.env: line 4/)).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.getByText('npm_secret_value_123')).toHaveCount(0);
    await expect(page.getByText('postgres://u:p@db/app')).toHaveCount(0);
    await expectNoHorizontalOverflow(page);
    await shot('code-project-env.png');
    // Remove one; replace the rest.
    page.once('dialog', (dialog) => void dialog.accept());
    await environment
      .getByRole('listitem')
      .filter({ hasText: 'DEBUG' })
      .getByRole('button', { name: 'Remove' })
      .click();
    await expect(environment.getByText('DEBUG')).toHaveCount(0);
    await environment.getByRole('button', { name: 'Replace .env' }).click();
    await environment.getByLabel('.env contents').fill('API_BASE_URL=https://api.example.test\n');
    await environment.getByRole('button', { name: 'Save' }).click();
    await expect(environment.getByText('API_BASE_URL')).toBeVisible();
    await expect(environment.getByText('NPM_TOKEN')).toHaveCount(0);

    // ── A chat started in the project: its title bar names the project,
    //    links back to it, and carries the code buttons ──
    await main.getByRole('button', { name: 'New chat' }).click();
    // First hit on the chat page in this test — and, beside it, the code
    // pane's own bundle: dev-mode's on-demand compile can outrun the
    // default assertion timeout.
    await expect(page.getByRole('heading', { name: `New chat in ${ids.seededName}` })).toBeVisible({
      timeout: 30_000,
    });
    const crumb = main.getByRole('link', { name: ids.seededName });
    await expect(crumb).toHaveAttribute('href', `/code/${ids.seededProjectId}`);
    await expect(main.getByRole('link', { name: 'Back to project' })).toHaveAttribute(
      'href',
      `/code/${ids.seededProjectId}`
    );
    // The code pane opens beside a code chat on a wide screen (its own
    // test below) and narrows the chat's column into its compact title
    // bar; these steps are about that bar's own buttons, so the pane is
    // put away first.
    if (!mobile) {
      await main.getByRole('button', { name: 'Hide the code' }).click();
      await expect(main.getByRole('tablist', { name: 'Open files' })).toHaveCount(0);
    }
    await expectNoHorizontalOverflow(page);
    await shot('code-chat-new.png');

    // On a phone the title bar keeps Tools and folds the rest into "More".
    const action = async (name: string) => {
      if (mobile) {
        await main.getByRole('button', { name: 'More' }).click();
        await main.getByRole('menuitem', { name }).click();
      } else await main.getByRole('button', { name }).click();
    };

    // ── Add files: picked (or dropped) files land in the checkout,
    //    untracked, for the chat's tools ──
    await action('Add files');
    const filesDialog = page.getByRole('dialog', { name: 'Add files' });
    await expect(filesDialog.getByText(/land as untracked files/)).toBeVisible();
    await filesDialog.getByLabel('Folder (optional)').fill('docs');
    await filesDialog.locator('input[type="file"]').setInputFiles({
      name: 'notes.md',
      mimeType: 'text/markdown',
      buffer: Buffer.from('# Notes\n'),
    });
    await expect(filesDialog.getByText('notes.md')).toBeVisible();
    await shot('code-chat-add-files.png');
    await filesDialog.getByRole('button', { name: 'Add to repository' }).click();
    await expect(filesDialog.getByText('Added to the checkout: docs/notes.md.')).toBeVisible();
    await filesDialog.getByRole('button', { name: 'Done' }).click();

    // ── Changes carries the checkout's +added −deleted and opens every
    //    diff (side by side on a wide screen); Environment opens the
    //    project's variables ──
    if (mobile) await main.getByRole('button', { name: 'More' }).click();
    const changes = mobile
      ? main.getByRole('menuitem', { name: 'Changes' })
      : main.getByRole('button', { name: 'Changes' });
    await expect(changes).toContainText('+3');
    await expect(changes).toContainText('−1');
    await changes.click();
    const changesDialog = page.getByRole('dialog', { name: 'Changes' });
    await expect(changesDialog.getByText('src/billing.ts')).toBeVisible();
    await expect(changesDialog.getByText(/MAX_ATTEMPTS/).first()).toBeVisible();
    await expect(
      changesDialog.getByRole('button', { name: 'Ask the chat to open a pull request' })
    ).toBeVisible();
    await shot('code-chat-changes.png');
    await changesDialog.getByRole('button', { name: 'Close' }).click();
    await action('Environment');
    const envDialog = page.getByRole('dialog', { name: 'Environment' });
    await expect(envDialog.getByText('API_BASE_URL')).toBeVisible();
    await shot('code-chat-env.png');
    await envDialog.getByRole('button', { name: 'Close' }).click();
    await main.getByRole('link', { name: 'Back to project' }).click();
    await expect(page.getByRole('heading', { level: 1, name: ids.seededName })).toBeVisible();
    await expect(main.getByRole('link', { name: ids.seededChatTitle })).toBeVisible();

    // ── A finished turn in the project's chat: the clone step reads as a
    //    sentence inside the work fold after the prompt; the commit is
    //    lifted out of the fold as a milestone card of its own, with its
    //    git glyph and the result on its line ──
    await main.getByRole('link', { name: ids.seededChatTitle }).click();
    await expect(main.getByText(QUESTION)).toBeVisible();
    const work = main.locator('details.chat-fold:not([data-milestone])').first();
    await expect(work).toContainText('2 tool calls');
    await work.locator('> summary').click();
    const steps = work.locator('ol > li > details.chat-fold');
    const cloneStep = steps.filter({ hasText: 'Cloned the repository' });
    await expect(cloneStep).toBeVisible();
    await cloneStep.locator('> summary').click();
    await expect(cloneStep.getByText(/4\.1 MB on the sandbox/)).toBeVisible();
    // The model's own deletion is a named step like any file change, with
    // the tree's changed files in its result.
    const deleteStep = steps.filter({ hasText: 'Delete file' });
    await expect(deleteStep).toBeVisible();
    await deleteStep.locator('> summary').click();
    await expect(deleteStep.getByText(`Deleted ${DELETED}`, { exact: false })).toBeVisible();
    const commitCard = main.locator('details[data-milestone="code_git_commit"]');
    await expect(commitCard).toBeVisible();
    await expect(commitCard).toContainText('Committed');
    await expect(commitCard).toContainText(/c0ffee\d+/);
    await expect(main.getByText('Calling', { exact: false })).toHaveCount(0);
    await shot('code-chat-transcript.png');
    if (!mobile) {
      // At phone width the opened step still reads whole, result lines included.
      const wide = page.viewportSize()!;
      await page.setViewportSize({ width: 390, height: 844 });
      await expect(deleteStep).toBeVisible();
      await expect(deleteStep.getByText(`Deleted ${DELETED}`, { exact: false })).toBeVisible();
      await expectNoHorizontalOverflow(page);
      await shot('code-chat-transcript-phone.png');
      await page.setViewportSize(wide);
    }
    await main.getByRole('link', { name: 'Back to project' }).click();
    await expect(page.getByRole('heading', { level: 1, name: ids.seededName })).toBeVisible();

    // ── A new code project through the form: the repository browsed on
    //    Bitbucket (workspace → project → repositories), a .env pasted,
    //    the brief there to start from; nothing cloned yet ──
    await page.goto(`/code/new`);
    await expect(page.getByRole('heading', { level: 1, name: 'New code project' })).toBeVisible();
    await expect(page.getByText('Connect Bitbucket first')).toHaveCount(0);
    const create = page.getByRole('button', { name: 'Create project' });
    await expect(create).toBeDisabled();
    await page.getByLabel(/^Name/).filter({ visible: true }).fill(ids.newName);
    const workspacePick = page.getByRole('combobox', { name: /^Workspace/ });
    await expect(workspacePick).toBeEnabled({ timeout: 15_000 });
    await workspacePick.selectOption('acme');
    const projectPick = page.getByRole('combobox', { name: /^Project/ });
    await expect(projectPick).toBeEnabled({ timeout: 15_000 });
    await projectPick.selectOption('NOTIF');
    const repoList = page.getByRole('list', { name: 'Repositories' });
    await expect(repoList.getByText('acme/notifications-gateway')).toBeVisible();
    await expect(repoList.getByText('acme/billing-service')).toHaveCount(0);
    await shot('code-new-browse.png');
    await repoList.getByRole('button', { name: /notifications-gateway/ }).click();
    await expect(page.getByText('acme/notifications-gateway')).toBeVisible();
    await expect(page.getByLabel('Branch (optional)')).toHaveAttribute('placeholder', 'develop');
    await page.getByLabel(/^\.env/).fill('SENDGRID_KEY=sg_live_abc\n');
    // The developer's brief is there to start from, and can be replaced.
    await expect(page.getByLabel(/^Instructions/)).toHaveValue(/test-first/);
    await page.getByLabel(/^Instructions/).fill('Run pnpm test before every commit.');
    await expectNoHorizontalOverflow(page);
    await shot('code-new.png');
    await expect(create).toBeEnabled();
    await create.click();
    await expect(page).toHaveURL(new RegExp(`/code/[0-9a-f-]{36}$`));
    await expect(page.getByRole('heading', { level: 1, name: ids.newName })).toBeVisible();
    const newRepo = sectionOf('Repository');
    await expect(newRepo.getByText('acme/notifications-gateway')).toBeVisible();
    await expect(newRepo.getByText('Not cloned yet')).toBeVisible();
    const newEnv = sectionOf('Environment');
    await expect(newEnv.getByText('SENDGRID_KEY')).toBeVisible();
    await expect(page.getByText('sg_live_abc')).toHaveCount(0);
    await expect(page.getByText('Run pnpm test before every commit.')).toBeVisible();

    // ── Delete: the confirm names what goes, and the index no longer lists it ──
    await page.getByRole('button', { name: 'Delete project' }).click();
    await expect(
      page.getByText(/checkout on the sandbox, its environment variables/)
    ).toBeVisible();
    await page.getByRole('button', { name: 'Delete', exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/code$`));
    await expect(main.getByRole('link', { name: ids.newName })).toHaveCount(0);
    await expect(main.getByRole('link', { name: ids.seededName })).toBeVisible();
  });

  test('the code pane: read, edit, save, commit and push beside the chat', async ({
    page: desktop,
    browser,
    person,
  }, testInfo) => {
    // The phone the old `mobile` project was: a touch device, not just a
    // narrow window (the pane picks its plain text area by pointer).
    const mobile = testInfo.project.name === 'desktop-dark';
    const page = mobile ? await phonePage(browser, person) : desktop;
    const shot = (name: string) =>
      page.screenshot({
        path: path.join(
          import.meta.dirname,
          '..',
          'test-results',
          'screens',
          testInfo.project.name,
          name
        ),
        fullPage: false,
      });
    const main = page.getByRole('main');
    await runFirstTurn(page, ids, true);
    await page.goto(`/chat/${ids.seededChatId}`);
    await expect(page.getByRole('heading', { name: ids.seededChatTitle })).toBeVisible();

    if (mobile) {
      // ── A phone: the pane is the Code tab of a switch in the title bar.
      //    It opens on the file tree (the branch above it, "New file"
      //    inline with the tree's own heading), with Commit along the
      //    bottom ──
      const tabs = main.getByRole('tablist', { name: 'Chat or code' });
      await expect(tabs.getByRole('tab', { name: /Chat/ })).toHaveAttribute(
        'aria-selected',
        'true'
      );
      await tabs.getByRole('tab', { name: /Code/ }).click();
      const tree = main.getByRole('tree', { name: 'Files' });
      await expect(tree.getByText('package.json')).toBeVisible({ timeout: 20_000 });
      await expect(main.getByRole('button', { name: /^Commit/ })).toBeVisible();
      await expectNoHorizontalOverflow(page);
      await shot('code-pane-mobile-files.png');

      // ── A file opens over the tree, in a plain text area with
      //    accessory keys, Save above the keyboard ──
      // (each row's own "More for <name>" button also matches on a loose
      // name — anchoring at the start keeps this the row's own button)
      await tree.getByRole('button', { name: 'src', exact: true }).click();
      await tree.getByRole('button', { name: /^billing\.ts/ }).click();
      const area = main.getByLabel('Contents of src/billing.ts');
      await expect(area).toBeVisible();
      await expect(area).toHaveValue(/MAX_ATTEMPTS/);
      await expect(main.getByRole('toolbar', { name: 'Keys' })).toBeVisible();
      // The text area is coloured: the same text drawn beneath it in the
      // chat's code palette, TypeScript keywords and strings told apart.
      const backdrop = main.locator('.code-area-backdrop');
      await expect(backdrop.locator('.hljs-keyword', { hasText: 'import' }).first()).toBeVisible();
      await expect(backdrop.locator('.hljs-string', { hasText: './util' })).toBeVisible();
      const save = main.getByRole('button', { name: 'Save to checkout' });
      await expect(save).toBeDisabled();
      await area.focus();
      await page.keyboard.press('Control+End');
      await page.keyboard.type('\n// reviewed by hand\n');
      await expect(save).toBeEnabled();
      await expect(tabs.getByRole('tab', { name: /Code/ })).toContainText('1');
      // What was just typed is coloured as it lands: a comment.
      await expect(
        backdrop.locator('.hljs-comment', { hasText: 'reviewed by hand' })
      ).toBeVisible();
      await expectNoHorizontalOverflow(page);
      await shot('code-pane-mobile-editing.png');
      await save.click();
      await expect(save).toBeDisabled();

      // ── Commit from the list, as a dialog; then the Chat tab shows what
      //    was done ──
      await main.getByRole('button', { name: 'Back to files' }).click();
      await main.getByRole('button', { name: /^Commit/ }).click();
      const dialog = page.getByRole('dialog', { name: 'Commit changes' });
      await expect(dialog.getByText('src/billing.ts')).toBeVisible();
      await expect(dialog.getByText('edited here')).toBeVisible();
      await dialog.getByLabel('Message').fill('Note the manual review');
      await shot('code-pane-mobile-commit.png');
      await dialog.getByRole('button', { name: /^Commit 1 file/ }).click();
      const done = page.getByRole('dialog', { name: 'Committed' });
      await expect(done.getByText(/Committed c0ffee/)).toBeVisible();
      await done.getByRole('button', { name: 'Done' }).click();
      await tabs.getByRole('tab', { name: /Chat/ }).click();
      await expect(main.getByText(/You edited/)).toBeVisible();
      await expect(main.getByText(/You committed c0ffee/)).toBeVisible();
      await expectNoHorizontalOverflow(page);
      await shot('code-pane-mobile-chat-notes.png');
      return;
    }

    // ── A wide screen: the pane beside the chat, open at first, with the
    //    back arrow at the page's left edge, the branch above the tree,
    //    and the chat in its compact form on the right ──
    const openFiles = main.getByRole('tablist', { name: 'Open files' });
    await expect(openFiles).toBeVisible();
    // First hits on the tree and diff routes in this test: dev-mode's
    // on-demand compile can outrun the default assertion timeout.
    const tree = main.getByRole('tree', { name: 'Files' });
    await expect(tree.getByText('package.json')).toBeVisible({ timeout: 20_000 });
    await expect(main.locator('[data-testid="pane-branch"]')).toContainText('renkei/');
    const back = main.getByRole('link', { name: 'Back to project' });
    await expect(back).toHaveAttribute('href', `/code/${ids.seededProjectId}`);
    expect((await back.boundingBox())!.x).toBeLessThan((await tree.boundingBox())!.x);
    expect((await back.boundingBox())!.x).toBeLessThan((await openFiles.boundingBox())!.x);
    // The chat column is narrow beside the pane: its title bar folds.
    await expect(main.getByRole('button', { name: 'More', exact: true })).toBeVisible();
    await expect(main.getByRole('button', { name: 'Changes' })).toHaveCount(0);

    // ── A file from the tree opens in Monaco, read as the checkout has it ──
    // (each row's own "More for <name>" button also matches on a loose
    // name — anchoring at the start keeps this the row's own button)
    await tree.getByRole('button', { name: 'src', exact: true }).click();
    await tree.getByRole('button', { name: /^billing\.ts/ }).click();
    await expect(openFiles.getByRole('tab', { name: /billing\.ts/ })).toHaveAttribute(
      'aria-selected',
      'true'
    );
    const editor = main.locator('.monaco-editor');
    await expect(editor).toBeVisible({ timeout: 20_000 });
    await expect(editor.getByText('MAX_ATTEMPTS').first()).toBeVisible();
    await expect(
      main.getByText('Saved to the checkout · not committed until you commit')
    ).toBeVisible();
    // Coloured as TypeScript, in the pane's own theme: the status line names
    // the language, and the tokens on screen are painted in several colours
    // (Monaco gives each colour of the theme its own class).
    await expect(main.getByText('TypeScript', { exact: true })).toBeVisible();
    await expect
      .poll(() =>
        editor
          .locator('.view-lines span[class*="mtk"]')
          .evaluateAll((spans) => new Set(spans.map((span) => span.className)).size)
      )
      .toBeGreaterThan(3);
    await expectNoHorizontalOverflow(page);
    await shot('code-pane-desktop.png');

    // ── Typing marks the tab and counts as unsaved; Save writes it to the
    //    checkout and the chat notes what was done ──
    const saveButton = main.getByRole('button', { name: /^Save/ });
    await expect(saveButton).toBeDisabled();
    await editor.locator('.view-lines').click();
    await page.keyboard.press('Control+End');
    await page.keyboard.type('\n// reviewed by hand\n');
    await expect(main.getByText('1 unsaved')).toBeVisible();
    await expect(saveButton).toBeEnabled();
    await expect(main.getByText('Unsaved edits · Save writes to the checkout')).toBeVisible();
    await shot('code-pane-desktop-editing.png');
    await saveButton.click();
    await expect(main.getByText('1 unsaved')).toHaveCount(0);
    await expect(main.getByText(/You edited/)).toBeVisible();
    await expect(main.getByRole('button', { name: 'src/billing.ts', exact: true })).toBeVisible();

    // ── Commit: the changed files with who-changed-what tags, a message,
    //    then the hash and a push ──
    await main.getByRole('button', { name: /^Commit/ }).click();
    const dialog = page.getByRole('dialog', { name: 'Commit changes' });
    await expect(dialog.getByText('src/billing.ts')).toBeVisible();
    await expect(dialog.getByText('edited here')).toBeVisible();
    await expect(dialog.getByText(/Nothing leaves the sandbox until you push/)).toBeVisible();
    await dialog.getByLabel('Message').fill('Note the manual review');
    await dialog.getByLabel('Description').fill('A comment for the next reader.');
    await shot('code-pane-desktop-commit.png');
    await dialog.getByRole('button', { name: /^Commit 1 file/ }).click();
    const done = page.getByRole('dialog', { name: 'Committed' });
    await expect(done.getByText(/Committed c0ffee/)).toBeVisible();
    await expect(done.getByText('not pushed')).toBeVisible();
    await done.getByRole('button', { name: 'Push branch' }).click();
    await expect(done.getByText(/pushed to origin\/renkei\//)).toBeVisible();
    await shot('code-pane-desktop-pushed.png');
    await done.getByRole('button', { name: 'Done' }).click();
    await expect(main.getByText(/You committed c0ffee/)).toBeVisible();
    await expect(main.getByText(/You pushed renkei\//)).toBeVisible();

    // ── Hidden, the chat takes the whole column back and the back arrow
    //    returns to its title bar; shown again, it comes back with its tabs ──
    await main.getByRole('button', { name: 'Hide the code' }).click();
    await expect(openFiles).toHaveCount(0);
    await expect(main.getByRole('button', { name: 'Changes' })).toBeVisible();
    await expect(main.getByRole('link', { name: 'Back to project' })).toBeVisible();
    await shot('code-pane-desktop-hidden.png');
    await main.getByRole('button', { name: 'Show the code' }).click();
    await expect(openFiles.getByRole('tab', { name: /billing\.ts/ })).toBeVisible();
  });

  test('the code pane: a language server behind the editor', async ({
    page: desktop,
    browser,
    person,
  }, testInfo) => {
    // The phone the old `mobile` project was: a touch device (see above).
    const mobile = testInfo.project.name === 'desktop-dark';
    const page = mobile ? await phonePage(browser, person) : desktop;
    const shot = (name: string) =>
      page.screenshot({
        path: path.join(
          import.meta.dirname,
          '..',
          'test-results',
          'screens',
          testInfo.project.name,
          name
        ),
        fullPage: false,
      });
    const main = page.getByRole('main');
    await runFirstTurn(page, ids, true);
    await page.goto(`/chat/${ids.seededChatId}`);
    await expect(page.getByRole('heading', { name: ids.seededChatTitle })).toBeVisible();

    if (mobile) {
      // A phone has the text area, which has no language server: the
      // file opens and colours as before, and nothing claims a server.
      const tabs = main.getByRole('tablist', { name: 'Chat or code' });
      await tabs.getByRole('tab', { name: /Code/ }).click();
      const tree = main.getByRole('tree', { name: 'Files' });
      await expect(tree.getByText('package.json')).toBeVisible({ timeout: 20_000 });
      // (each row's own "More for <name>" button also matches on a loose
      // name — anchoring at the start keeps this the row's own button)
      await tree.getByRole('button', { name: 'src', exact: true }).click();
      await tree.getByRole('button', { name: /^billing\.ts/ }).click();
      await expect(main.getByLabel('Contents of src/billing.ts')).toHaveValue(/MAX_ATTEMPTS/);
      await expect(main.getByText(/language server/)).toHaveCount(0);
      return;
    }

    // ── The file opens; the stub worker has a TypeScript server, which the
    //    pane starts and names in the status line ──
    const tree = main.getByRole('tree', { name: 'Files' });
    await expect(tree.getByText('package.json')).toBeVisible({ timeout: 20_000 });
    // (each row's own "More for <name>" button also matches on a loose
    // name — anchoring at the start keeps this the row's own button)
    await tree.getByRole('button', { name: 'src', exact: true }).click();
    await tree.getByRole('button', { name: /^billing\.ts/ }).click();
    const editor = main.locator('.monaco-editor');
    await expect(editor).toBeVisible({ timeout: 20_000 });
    await expect(editor.getByText('MAX_ATTEMPTS').first()).toBeVisible();
    await expect(
      main.getByRole('status').filter({ hasText: 'TypeScript language server' })
    ).toBeVisible({
      timeout: 20_000,
    });

    // ── The server's diagnostic is a marker on the declaration it names ──
    await expect(editor.locator('.squiggly-warning').first()).toBeVisible({ timeout: 20_000 });

    // ── Hover asks the server; its answer is the hover card ──
    // Monaco keeps two hover widgets (the text's and the glyph margin's);
    // the one that shows is the text's. A hover that lands while the editor
    // is still settling is dropped, so the pointer moves off and back.
    const hover = page.locator('.monaco-hover:not(.hidden)');
    await expect(async () => {
      await page.mouse.move(0, 0);
      await editor.getByText('MAX_ATTEMPTS').first().hover();
      await expect(hover).toBeVisible({ timeout: 4_000 });
    }).toPass({ timeout: 40_000 });
    await expect(hover).toContainText('From the stub language server');
    await shot('code-pane-lsp-hover.png');

    // ── Completion comes from the server too ──
    await page.keyboard.press('Escape');
    await editor.locator('.view-lines').click();
    await page.keyboard.press('Control+End');
    await page.keyboard.press('Enter');
    await page.keyboard.type('ret');
    const suggest = page.locator('.suggest-widget');
    try {
      await expect(suggest).toBeVisible({ timeout: 5_000 });
    } catch {
      // Quick suggestions did not open it; ask outright.
      await page.keyboard.press('Control+Space');
    }
    await expect(suggest).toBeVisible({ timeout: 20_000 });
    // The label and its detail line both carry the name; the label is first.
    await expect(suggest.getByText('retryInvoice', { exact: true }).first()).toBeVisible({
      timeout: 20_000,
    });
    await shot('code-pane-lsp-completion.png');
    await page.keyboard.press('Escape');

    // ── Go to definition lands in another file: it opens as a tab of the
    //    pane, its model loaded, the range revealed ──
    await page.keyboard.press('Control+Home');
    await page.keyboard.press('F12');
    const openFiles = main.getByRole('tablist', { name: 'Open files' });
    await expect(openFiles.getByRole('tab', { name: /index\.ts/ })).toHaveAttribute(
      'aria-selected',
      'true',
      { timeout: 20_000 }
    );
    await expect(editor.getByText('retryInvoice').first()).toBeVisible();
    await shot('code-pane-lsp-definition.png');

    // Back on the first tab the server is still attached (one per language, not per file).
    await openFiles
      .getByRole('tab', { name: /billing\.ts/ })
      .getByRole('button')
      .first()
      .click();
    await expect(
      main.getByRole('status').filter({ hasText: 'TypeScript language server' })
    ).toBeVisible();

    // ── A file whose language has no server opens all the same, with no
    //    server claimed. (It is also counted in code_language_gaps, which has
    //    no UI and no route — an operator's query — so it is not read here.)
    await tree.getByRole('button', { name: /^package\.json/ }).click();
    await expect(openFiles.getByRole('tab', { name: /package\.json/ })).toHaveAttribute(
      'aria-selected',
      'true'
    );
  });

  test('new project via a freshly created Bitbucket repository', async ({ page }, testInfo) => {
    const shot = (name: string) =>
      page.screenshot({
        path: path.join(
          import.meta.dirname,
          '..',
          'test-results',
          'screens',
          testInfo.project.name,
          name
        ),
        fullPage: false,
      });
    const main = page.getByRole('main');
    const sectionOf = (name: string) =>
      main.locator('section', { has: page.getByRole('heading', { level: 2, name }) });

    // ── "Create new repository", beside "Choose existing": pick the
    //    workspace and project, name it, and an empty repo appears on
    //    Bitbucket — used exactly like one the browser would have found ──
    await page.goto(`/code/new`);
    await page.getByLabel(/^Name/).filter({ visible: true }).fill(ids.createdRepoName);
    await page.getByRole('tab', { name: 'Create new' }).click();
    const workspacePick = page.getByRole('combobox', { name: /^Workspace/ });
    await expect(workspacePick).toBeEnabled({ timeout: 15_000 });
    await workspacePick.selectOption('acme');
    const projectPick = page.getByRole('combobox', { name: /^Project/ });
    await expect(projectPick).toBeEnabled({ timeout: 15_000 });
    await projectPick.selectOption('NOTIF');
    const createRepo = page.getByRole('button', { name: 'Create repository', exact: true });
    await expect(createRepo).toBeDisabled();
    await page.getByLabel('Repository name').fill(ids.createdRepoName);
    await expect(
      page.getByText(`Creates acme/${ids.createdRepoSlug} — empty and private.`)
    ).toBeVisible();
    await expect(createRepo).toBeEnabled();
    await shot('code-new-create-repo.png');
    await createRepo.click();

    // ── The created repo drops into the same "chosen" slot a browsed one
    //    would; the rest of the form (branch placeholder, instructions,
    //    Create project) behaves identically to an existing repository. Its
    //    initial commit lands on `main`, so that is its main branch ──
    await expect(page.getByText(`acme/${ids.createdRepoSlug}`)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Choose another' })).toBeVisible();
    await expect(page.getByLabel('Branch (optional)')).toHaveAttribute('placeholder', 'main');
    const create = page.getByRole('button', { name: 'Create project' });
    await expect(create).toBeEnabled();
    await create.click();
    // First hit on these routes in this test (unlike the big walkthrough
    // above, which has already warmed them up) — dev-mode's on-demand
    // compile can outrun the default assertion timeout.
    await expect(page).toHaveURL(new RegExp(`/code/[0-9a-f-]{36}$`), {
      timeout: 20_000,
    });
    await expect(page.getByRole('heading', { level: 1, name: ids.createdRepoName })).toBeVisible();
    const newRepo = sectionOf('Repository');
    await expect(newRepo.getByText(`acme/${ids.createdRepoSlug}`)).toBeVisible();
    await expect(newRepo.getByText('Not cloned yet')).toBeVisible();
  });
});
