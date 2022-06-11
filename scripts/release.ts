/**
 * modified from https://github.com/vuejs/core/blob/master/scripts/release.js
 */
import colors from 'picocolors';
import type { ExecaChildProcess, Options as ExecaOptions } from 'execa';
import { execa } from 'execa';
import { readFileSync, writeFileSync } from 'fs';
import path from 'path';
import prompts from 'prompts';
import type { ReleaseType } from 'semver';
import * as semver from 'semver';
import minimist from 'minimist';

const args = minimist(process.argv.slice(2));

const pkgDir = process.cwd();
const pkgPath = path.resolve(pkgDir, 'package.json');

// eslint-disable-next-line import/no-dynamic-require,@typescript-eslint/no-require-imports
const pkg: { name: string; version: string } = require(pkgPath);
const pkgName = pkg.name.replace(/^@tencent\//, '').replace('tds-vue-plugin-', '');
const currentVersion = pkg.version;
const isDryRun: boolean = args.dry;
const { skipBuild } = args;

const versionIncrements: ReleaseType[] = ['patch', 'minor', 'major', 'prepatch', 'preminor', 'premajor', 'prerelease'];

const inc: (i: ReleaseType) => string = (i) => semver.inc(currentVersion, i, 'beta')!;

type RunFn = (bin: string, args: string[], opts?: ExecaOptions<string>) => ExecaChildProcess<string>;

const run: RunFn = (bin, args, opts = {}) => execa(bin, args, { stdio: 'inherit', ...opts });

type DryRunFn = (bin: string, args: string[], opts?: any) => void;

const dryRun: DryRunFn = (bin, args, opts: any) => console.log(colors.blue(`[dryrun] ${bin} ${args.join(' ')}`), opts);

const runIfNotDry = isDryRun ? dryRun : run;

const step: (msg: string) => void = (msg) => console.log(colors.cyan(msg));

function updateVersion(version: string): void {
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
  pkg.version = version;
  writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
}

async function publishPackage(version: string, runIfNotDry: RunFn | DryRunFn): Promise<void> {
  const publicArgs = ['publish', '--no-git-tag-version', '--new-version', version, '--access', 'public'];
  if (args.tag) {
    publicArgs.push(`--tag`, args.tag);
  }
  try {
    // important: we still use Yarn 1 to publish since we rely on its specific
    // behavior
    await runIfNotDry('yarn', publicArgs, {
      stdio: 'pipe',
    });
    console.log(colors.green(`Successfully published ${pkgName}@${version}`));
  } catch (e: any) {
    if (e.stderr.match(/previously published/)) {
      console.log(colors.red(`Skipping already published: ${pkgName}`));
    } else {
      throw e;
    }
  }
}

async function main(): Promise<void> {
  // 获取第一个参数，作为 targetVersion
  let targetVersion: string | undefined = args._[0];

  // 没有显示指定 targetVersion，则通过命令行交互选择生成
  if (!targetVersion) {
    // 命令行交互
    const { release }: { release: string } = await prompts({
      type: 'select',
      name: 'release',
      message: 'Select release type',
      choices: versionIncrements
        .map((i) => `${i} (${inc(i)})`)
        .concat(['custom'])
        .map((i) => ({ value: i, title: i })),
    });

    if (release === 'custom') {
      const res: { version: string } = await prompts({
        type: 'text',
        name: 'version',
        message: 'Input custom version',
        initial: currentVersion,
      });
      targetVersion = res.version;
    } else {
      // eslint-disable-next-line prefer-destructuring
      targetVersion = release.match(/\((.*)\)/)![1];
    }
  }

  // 校验 targetVersion
  if (!semver.valid(targetVersion)) {
    throw new Error(`invalid target version: ${targetVersion}`);
  }

  // 生成标签
  const tag = pkgName === `${pkgName}@${targetVersion}`;

  // 是否打 beta 标签
  if (targetVersion.includes('beta') && !args.tag) {
    const { tagBeta }: { tagBeta: boolean } = await prompts({
      type: 'confirm',
      name: 'tagBeta',
      message: `Publish under dist-tag "beta"?`,
    });

    if (tagBeta) args.tag = 'beta';
  }

  // 二次确认是否发布
  const { yes }: { yes: boolean } = await prompts({
    type: 'confirm',
    name: 'yes',
    message: `Releasing ${tag}. Confirm?`,
  });

  if (!yes) {
    return;
  }

  // 更新 package.json 的 version
  step('\nUpdating package version...');
  updateVersion(targetVersion);

  // 打包，运行 pnpm run build
  step('\nBuilding package...');
  if (!skipBuild && !isDryRun) {
    await run('pnpm', ['run', 'build']);
  } else {
    console.log(`(skipped)`);
  }

  // pnpm run changelog
  step('\nGenerating changelog...');
  await run('pnpm', ['run', 'changelog']);

  // git diff，构建后可能会有新代码
  // 如果还有未提交的代码，就会提交，并打标签
  const { stdout } = await run('git', ['diff'], { stdio: 'pipe' });

  if (stdout) {
    step('\nCommitting changes...');
    await runIfNotDry('git', ['add', '-A']);
    await runIfNotDry('git', ['commit', '-m', `release: ${tag}`]);
    await runIfNotDry('git', ['tag', tag]);
  } else {
    console.log('No changes to commit.');
  }

  // 发布到 npm
  step('\nPublishing package...');
  await publishPackage(targetVersion, runIfNotDry);

  // 推送到 github
  step('\nPushing to GitHub...');
  await runIfNotDry('git', ['push', 'origin', `refs/tags/${tag}`]);
  await runIfNotDry('git', ['push']);

  if (isDryRun) {
    console.log(`\nDry run finished - run git diff to see package changes.`);
  }

  console.log();
}

main().catch((err) => {
  console.error(err);
});
