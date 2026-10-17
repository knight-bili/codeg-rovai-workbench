import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel) => JSON.parse(readFileSync(path.join(root, rel), 'utf8'));
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });
const assert = (condition, message) => { if (!condition) throw new Error(message); };
const source = read('integration/sources.lock.json');
const features = read('integration/planning/features.json');
const cases = read('integration/acceptance/cases.json');
const tasks = read('integration/planning/work-packages.json');
const schedule = read('integration/planning/schedule.json');
const runtime = read('integration/planning/runtime-matrix.json');
const entries = read('integration/inventory/source-entrypoints.json');
const ids = new Set(features.map((x) => x.id));
const caseIds = new Set(cases.map((x) => x.id));
const phases = new Set(schedule.phases.map((x) => x.id));
const baselineFeatureIds = [
  ...Array.from({ length: 44 }, (_, i) => `C${String(i + 1).padStart(2, '0')}`),
  ...Array.from({ length: 35 }, (_, i) => `R${String(i + 1).padStart(2, '0')}`),
  'M01', 'M02',
];
assert(source.sources.length === 4, '必须锁定四份源码');
assert(new Set(source.sources.map((x) => x.id)).size === 4 && ['codeg', 'rovai-ai', 'codeg-ios', 'codeg-android'].every((id) => source.sources.some((x) => x.id === id)), '源码来源缺失或重复');
assert(ids.size === features.length && features.length >= 81, '来源能力缺失或重复');
assert(baselineFeatureIds.every((id) => ids.has(id)), '固定基线能力被删除或替换');
assert(caseIds.size === cases.length && cases.length >= 324, '场景缺失或重复');
assert(new Set(tasks.map((x) => x.id)).size === tasks.length && tasks.length >= 48, '工作包缺失或重复');
for (const s of source.sources) {
  assert(/^[a-f0-9]{40}$/.test(s.commit), `非法来源提交 ${s.id}`);
  for (const license of s.retained_licenses) {
    assert(!path.isAbsolute(license.retained_path) && !license.retained_path.includes('..'), '许可证路径越界');
    const data = readFileSync(path.join(root, license.retained_path));
    assert(createHash('sha256').update(data).digest('hex') === license.sha256, `许可证被修改 ${s.id}`);
  }
}
const base = source.sources.find((x) => x.id === 'rovai-ai').commit;
git('merge-base', '--is-ancestor', base, 'HEAD');
for (const f of features) {
  assert(f.scope === '一期必须' && phases.has(f.phase), `来源范围或阶段错误 ${f.id}`);
  const owner = source.sources.find((s) => s.id === f.repo);
  assert(owner && f.url === `${owner.repository}/blob/${owner.commit}/${f.path}#L${f.line}`, `来源链接未固定 ${f.id}`);
  assert(/^[a-f0-9]{64}$/.test(f.source_sha256), `来源hash缺失 ${f.id}`);
  assert(f.primary_work_packages.length > 0 && f.primary_work_packages.every((id) => tasks.some((t) => t.id === id && t.phase === f.phase)), `工作包映射缺失 ${f.id}`);
  assert(f.acceptance_cases.length >= 4 && f.acceptance_cases.every((id) => cases.some((c) => c.id === id && c.feature === f.id && c.phase === f.phase)), `场景映射缺失 ${f.id}`);
  assert(new Set(f.acceptance_cases).size === f.acceptance_cases.length && ['N', 'F', 'R', 'P'].every((kind) => f.acceptance_cases.includes(`${f.id}-${kind}`)), `基线场景缺失或重复绑定 ${f.id}`);
}
for (const c of cases) {
  assert(ids.has(c.feature) && phases.has(c.phase) && c.steps && c.expected && c.platforms.length, `场景不完整 ${c.id}`);
  assert(['not_run', 'passed', 'failed', 'blocked', 'local_engineering_verified_environment_validation_pending'].includes(c.status), `场景状态错误 ${c.id}`);
  assert(!['passed', 'local_engineering_verified_environment_validation_pending'].includes(c.status) || c.evidence, `已核定用例缺少证据 ${c.id}`);
  if (c.status === 'local_engineering_verified_environment_validation_pending') {
    const [file, id] = c.evidence.split('#');
    assert(!path.isAbsolute(file) && !file.includes('..') && id === c.id, `本机证据路径或场景归属错误 ${c.id}`);
    const evidence = read(file).formal_cases?.find(row => row.id === c.id);
    assert(evidence?.status === c.status && evidence.remaining?.length > 0, `本机资格未保留待验证范围 ${c.id}`);
    assert(c.platforms.every(platform => typeof evidence.platform_state?.[platform] === 'string'), `本机资格缺少平台状态 ${c.id}`);
    assert(existsSync(path.join(root, 'integration/execution', evidence.current_candidate_evidence)), `本机资格缺少当前候选记录 ${c.id}`);
  }
}
assert(runtime.runtimes.length >= 21 && runtime.custom_acp, 'Runtime并集缺失');
assert(new Set(runtime.runtimes.map((x) => x.id)).size === runtime.runtimes.length, 'Runtime重复');
assert(entries.count === entries.entries.length && entries.count > 0, '入口库存不完整');
const weekdayCount = (start, end) => {
  const date = new Date(`${start}T00:00:00Z`), last = new Date(`${end}T00:00:00Z`); let count = 0;
  assert(Number.isFinite(date.valueOf()) && Number.isFinite(last.valueOf()) && date <= last, '非法日期');
  while (date <= last) { if (date.getUTCDay() !== 0 && date.getUTCDay() !== 6) count++; date.setUTCDate(date.getUTCDate() + 1); }
  return count;
};
for (const p of schedule.phases) assert(weekdayCount(p.start, p.end) === p.days, `阶段日期天数不一致 ${p.id}`);
assert(phases.size === schedule.phases.length && ['I00', 'I01', 'I02', 'I03', 'I04', 'I05', 'I06', 'I07', 'I08', 'I09', 'I10', 'I11', 'I12', 'BUF'].every((id) => phases.has(id)), '阶段缺失或重复');
for (let i = 1; i < schedule.phases.length; i++) assert(schedule.phases[i].start > schedule.phases[i - 1].end, `顺序排期重叠 ${schedule.phases[i].id}`);
assert(schedule.phases.reduce((sum, p) => sum + p.days, 0) === schedule.total_days, '总天数不一致');
assert(schedule.base_days + schedule.reserve_days === schedule.total_days, '预留天数不一致');

// 只扫描融合新增或改动文件，源历史不被误报为已经做过全历史审计。
const changed = new Set([
  ...git('diff', '--name-only', base, '--').trim().split(/\r?\n/),
  ...git('ls-files', '--others', '--exclude-standard').trim().split(/\r?\n/),
]);
const sensitivePath = /(^|\/)(\.env(?:\..+)?|id_rsa|id_ed25519)$|\.(?:p12|jks|keystore|mobileprovision)$/i;
const sensitiveContent = [/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/, /\bgh[pousr]_[A-Za-z0-9]{30,}\b/, /\bgithub_pat_[A-Za-z0-9_]{40,}\b/, /\bAKIA[A-Z0-9]{16}\b/];
for (const file of changed) {
  if (!file || !existsSync(path.join(root, file))) continue;
  assert(!sensitivePath.test(file) || file.endsWith('.env.example'), `新增敏感文件 ${file}`);
  if (/\.(?:json|md|csv|mjs|yml|yaml|txt)$/.test(file)) {
    const content = readFileSync(path.join(root, file), 'utf8');
    assert(!sensitiveContent.some((pattern) => pattern.test(content)), `新增文件疑似包含秘密 ${file}`);
  }
}
console.log(JSON.stringify({status:'passed', features:features.length, cases:cases.length, workPackages:tasks.length, sourceEntrypoints:entries.count, runtimeKinds:runtime.runtimes.length, totalDays:schedule.total_days, fullyPassedCases:cases.filter(c => c.status === 'passed').length, localCasesPendingEnvironment:cases.filter(c => c.status === 'local_engineering_verified_environment_validation_pending').length, productExecution:'see_per_case_evidence'}));
