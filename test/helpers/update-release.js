import { readFileSync } from 'node:fs';
import vm from 'node:vm';

export const releaseFiles = () => Object.fromEntries(['package.json', 'CHANGELOG.md', 'UPDATE_NOTES.json']
  .map((file) => [file, readFileSync(new URL('../../' + file, import.meta.url), 'utf8')]));

// Actual historical functions, not a reimplementation. The network, installation
// record and running version are synthetic; no production service is contacted.
export async function legacyReleaseCheck({ sameVersion = false } = {}) {
  const files = releaseFiles();
  if (sameVersion) files['package.json'] = JSON.stringify({ version: '0.11.1' });
  const notes = JSON.parse(files['UPDATE_NOTES.json']);
  const targetSha = 'a'.repeat(40); // local, uncommitted release candidate fixture
  const oldSha = 'b'.repeat(40);
  const candidate = { sha: targetSha, commit: {
    message: 'feat: default to local content and audit API sources [skip ci]\n\n- 默认诗词和一言使用本地句库，准确标注接口来源。\n- 明确首次导入、空库503与文章发现尚未自动化；内部测试按配置账号/Key ID隔离。',
    committer: { date: '2026-10-17T16:00:00Z' },
  } };
  const selected = notes.filter((n) => ['b92ad7c', 'd5db3e9', '6be54ee', '9a20a6d'].some((prefix) => n.sha.startsWith(prefix)));
  const commits = selected.map((n) => ({ sha: n.sha, commit: {
    message: n.sha.startsWith('9a20a6d') ? 'feat: persist self-hosted 60s editions and controlled updates [skip ci]'
      : n.sha.startsWith('6be54ee') ? 'feat: internal traffic\n\n普通段落：内部统计'
        : 'fix: synthetic technical message\n\n- SHA Git blob ahead/identical technical fixture',
    committer: { date: '2026-10-17T12:00:00Z' },
  } }));
  commits.push(candidate);
  const requests = [];
  const context = vm.createContext({
    process: { env: { MIAO_LAUNCHER: '1' } },
    currentVersion: () => ({ version: '0.11.1', sha: oldSha, updatedAt: '2026-10-15T15:50:41Z' }),
    localVersion: () => '0.11.1', RUNNING_VERSION: '0.11.1', lastRollback: () => null,
    remoteFile: async (_repo, _sha, path) => files[path],
    gh: async (path) => {
      requests.push(path);
      if (path.includes('/commits/')) return candidate;
      if (path.includes('/compare/')) return { status: 'ahead', ahead_by: commits.length, commits };
      throw new Error('Unexpected synthetic GitHub read');
    },
  });
  const source = readFileSync(new URL('../fixtures/update-v0.11.1-reader.txt', import.meta.url), 'utf8').replace(/^export /gm, '');
  vm.runInContext(source + '\nglobalThis.readUpdate = checkUpdateFresh;', context, { timeout: 1000 });
  const result = await context.readUpdate({ repo: 'bocmiao/api', branch: 'Miao-API' });
  return { result: JSON.parse(JSON.stringify(result)), requests };
}
