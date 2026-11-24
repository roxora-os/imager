// What the About dialog says about a build: the commit it is built from
// (CI's, else git's), the build date (UTC) and the PatternFly it bundles.
// esbuild defines for the page; the page checks with typeof, so a build
// without them still runs.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const git = (...a) => { try { return execFileSync('git', a, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return ''; } };

export function buildDefines() {
  const commit = (process.env.GITHUB_SHA ?? git('rev-parse', 'HEAD')).slice(0, 7) || 'unknown';
  const date = new Date().toISOString().slice(0, 10);
  const patternfly = JSON.parse(readFileSync('node_modules/@patternfly/patternfly/package.json', 'utf8')).version;
  return { __BUILD_COMMIT__: JSON.stringify(commit), __BUILD_DATE__: JSON.stringify(date), __PATTERNFLY_VERSION__: JSON.stringify(patternfly) };
}
