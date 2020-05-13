/**
 * Inspired by create-next-app
 */
import chalk from 'chalk';
import fs from 'fs';
import got from 'got';
import path from 'path';
import prompts from 'prompts';
import { Stream } from 'stream';
import tar from 'tar';
import { promisify } from 'util';

// @ts-ignore
const pipeline = promisify(Stream.pipeline);

type RepoInfo = {
  username: string;
  name: string;
  branch: string;
  filePath: string;
};

export async function promptAsync(): Promise<string | null> {
  const { value } = await prompts({
    type: 'select',
    name: 'value',
    message: 'How would you like to start',
    choices: [
      { title: 'Default new app', value: 'default' },
      { title: 'Examples from Expo', value: 'example' },
    ],
  });

  if (!value) {
    console.log();
    console.log('Please specify the template');
    process.exit(1);
  }

  if (value === 'example') {
    let examplesJSON: any;

    try {
      examplesJSON = await listAsync();
    } catch (error) {
      console.log();
      console.log('Failed to fetch the list of examples with the following error:');
      console.error(error);
      console.log();
      console.log('Switching to the default starter app');
      console.log();
    }

    if (examplesJSON) {
      const choices = examplesJSON.map(({ name }: any) => ({
        title: name,
        value: name,
      }));
      // The search function built into `prompts` isn’t very helpful:
      // someone searching for `styled-components` would get no results since
      // the example is called `with-styled-components`, and `prompts` searches
      // the beginnings of titles.
      const nameRes = await prompts({
        type: 'autocomplete',
        name: 'exampleName',
        message: 'Pick an example',
        choices,
        suggest: (input: any, choices: any) => {
          const regex = new RegExp(input, 'i');
          return choices.filter((choice: any) => regex.test(choice.title));
        },
      });

      if (!nameRes.exampleName) {
        console.log();
        console.log('Please specify an example or use the default starter app.');
        process.exit(1);
      }

      return nameRes.exampleName.trim();
    }
  }

  return null;
}

async function isUrlOk(url: string): Promise<boolean> {
  const res = await got(url).catch(e => e);
  return res.statusCode === 200;
}

export async function getRepoInfo(url: any, examplePath?: string): Promise<RepoInfo | undefined> {
  const [, username, name, t, _branch, ...file] = url.pathname.split('/');
  const filePath = examplePath ? examplePath.replace(/^\//, '') : file.join('/');

  // Support repos whose entire purpose is to be an example, e.g.
  // https://github.com/:username/:my-cool-example-repo-name.
  if (t === undefined) {
    const infoResponse = await got(`https://api.github.com/repos/${username}/${name}`).catch(
      e => e
    );
    if (infoResponse.statusCode !== 200) {
      return;
    }
    const info = JSON.parse(infoResponse.body);
    return { username, name, branch: info['default_branch'], filePath };
  }

  // If examplePath is available, the branch name takes the entire path
  const branch = examplePath
    ? `${_branch}/${file.join('/')}`.replace(new RegExp(`/${filePath}|/$`), '')
    : _branch;

  if (username && name && branch && t === 'tree') {
    return { username, name, branch, filePath };
  }
  return undefined;
}

export function hasRepo({ username, name, branch, filePath }: RepoInfo) {
  const contentsUrl = `https://api.github.com/repos/${username}/${name}/contents`;
  const packagePath = `${filePath ? `/${filePath}` : ''}/package.json`;

  return isUrlOk(contentsUrl + packagePath + `?ref=${branch}`);
}

export async function resolveTemplateArgAsync(
  projectRoot: string,
  oraInstance: any,
  template: string,
  templatePath?: string
) {
  let repoInfo: RepoInfo | undefined;

  if (template) {
    // @ts-ignore
    let repoUrl: URL | undefined;

    try {
      // @ts-ignore
      repoUrl = new URL(template);
    } catch (error) {
      if (error.code !== 'ERR_INVALID_URL') {
        oraInstance.error(error);
        process.exit(1);
      }
    }

    if (repoUrl) {
      if (repoUrl.origin !== 'https://github.com') {
        oraInstance.error(
          `Invalid URL: ${chalk.red(
            `"${template}"`
          )}. Only GitHub repositories are supported. Please use a GitHub URL and try again.`
        );
        process.exit(1);
      }

      repoInfo = await getRepoInfo(repoUrl, templatePath);

      if (!repoInfo) {
        oraInstance.error(
          `Found invalid GitHub URL: ${chalk.red(
            `"${template}"`
          )}. Please fix the URL and try again.`
        );
        process.exit(1);
      }

      const found = await hasRepo(repoInfo);

      if (!found) {
        oraInstance.error(
          `Could not locate the repository for ${chalk.red(
            `"${template}"`
          )}. Please check that the repository exists and try again.`
        );
        process.exit(1);
      }
    } else {
      const found = await hasExample(template);

      if (!found) {
        oraInstance.error(
          `Could not locate an example named ${chalk.red(
            `"${template}"`
          )}. Please check your spelling and try again.`
        );
        process.exit(1);
      }
    }
  }

  if (repoInfo) {
    oraInstance.text = chalk.bold(
      `Downloading files from repo ${chalk.cyan(template)}. This might take a moment.`
    );

    await downloadAndExtractRepo(projectRoot, repoInfo);
  } else {
    oraInstance.text = chalk.bold(
      `Downloading files for example ${chalk.cyan(template)}. This might take a moment.`
    );

    await downloadAndExtractExample(projectRoot, template);
  }

  await ensureProjectHasGitIgnore(projectRoot);

  return true;
}

function ensureProjectHasGitIgnore(projectRoot: string): void {
  // Copy our default `.gitignore` if the application did not provide one
  const ignorePath = path.join(projectRoot, '.gitignore');
  if (!fs.existsSync(ignorePath)) {
    fs.copyFileSync(require.resolve('../template/gitignore'), ignorePath);
  }
}

function hasExample(name: string): Promise<boolean> {
  return isUrlOk(
    `https://api.github.com/repos/expo/examples/contents/${encodeURIComponent(name)}/package.json`
  );
}

function downloadAndExtractRepo(
  root: string,
  { username, name, branch, filePath }: RepoInfo
): Promise<void> {
  const strip = filePath ? filePath.split('/').length + 1 : 1;
  return pipeline(
    got.stream(`https://codeload.github.com/${username}/${name}/tar.gz/${branch}`),
    tar.extract({ cwd: root, strip }, [`${name}-${branch}${filePath ? `/${filePath}` : ''}`])
  );
}

function downloadAndExtractExample(root: string, name: string): Promise<void> {
  return pipeline(
    got.stream('https://codeload.github.com/expo/examples/tar.gz/master'),
    tar.extract({ cwd: root, strip: 2 }, [`examples-master/${name}`])
  );
}

async function listAsync(): Promise<any> {
  const res = await got('https://api.github.com/repos/expo/examples/contents');
  const results = JSON.parse(res.body);
  return results.filter(({ name, type }: any) => type === 'dir' && !name?.startsWith('.'));
}
