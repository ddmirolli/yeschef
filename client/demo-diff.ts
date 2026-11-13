// The made-up code behind Iris's PR in the team demo (Fernpay #440, client/demo-team.ts), as T3 Code hands a PR's diff
// over (POST /api/pull-requests/diff): a unified patch built from GitHub's files list, each of the 41 files with its exact
// counts, and the lockfile withheld, as GitHub does with a change too large to inline. The site demo draws it with the
// app's own pipe, client/diffs.ts, when the demo is made (site/scripts/generate-demo.ts). Same output on every run.
import { IRIS } from './demo-team.ts';
import type { Withheld } from './diffs.ts';

/** The PR this patch belongs to, as the team demo names it. */
export const DEMO_DIFF_PR = { repo: 'fernpay/fernpay', n: 440 } as const;
/** GitHub withheld the lockfile's code; T3 lists it with its counts (omittedFileStats). */
const LOCK: Withheld = { path: 'pnpm-lock.yaml', additions: 2104, deletions: 0 };

// A statement export's fields. Each file's code is about one field per function, row, or test, so it reads like the
// work it stands in for.
const FIELDS = ['postedAt', 'valueDate', 'description', 'reference', 'counterparty', 'counterpartyIban', 'amount', 'currency', 'balance', 'fee',
  'tax', 'category', 'merchant', 'merchantCity', 'mcc', 'cardLast4', 'payoutId', 'batchId', 'status', 'memo', 'invoiceNumber', 'customerId',
  'accountId', 'accountName', 'settlementDate', 'exchangeRate', 'originalAmount', 'originalCurrency', 'feeCurrency', 'netAmount', 'grossAmount',
  'refundId', 'disputeId', 'chargeId', 'channel', 'country', 'region', 'statementId', 'lineNumber', 'createdBy', 'approvedBy', 'notes', 'tags',
  'externalId', 'entryType'] as const;

const pascal = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);
const constant = (s: string): string => s.replace(/[A-Z]/g, (c) => `_${c}`).toUpperCase();
const words = (s: string): string => s.replace(/[A-Z0-9]+/g, (c) => ` ${c.toLowerCase()}`);
const kebab = (s: string): string => words(s).trim().replaceAll(' ', '-');
const stemOf = (path: string): string => path.slice(path.lastIndexOf('/') + 1).replace(/\.test\.ts$|\.tsx?$/, '');
/** A steady number from a path: where its fields start, and its blob ids. */
function seed(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619) >>> 0;
  return h;
}

/** A line, or one a unit may add to take up a count exactly. */
type Line = string | { opt: string };
/** How one kind of file writes code: a unit (a function, a row, a test) and a one-line statement for what is left. */
interface Style { unit: (f: string, i: number) => Line[]; single: (f: string, i: number) => string }

/** Exactly `n` lines: whole units, their optional lines to take up the rest, then one-line statements first if still short. */
function fill(style: Style, n: number, start: number): string[] {
  const field = (i: number): string => FIELDS[(start + i) % FIELDS.length]!;
  const probe = style.unit(FIELDS[0], 0);
  const base = probe.filter((l) => typeof l === 'string').length, opts = probe.length - base;
  const units = n >= base ? Math.floor(n / base) : 0;
  let spare = n - units * base;
  const extra = Array.from({ length: units }, () => 0);
  for (let i = 0; spare > 0 && i < units * opts; i++) { extra[i % units]!++; spare--; }
  const out = Array.from({ length: spare }, (_, i) => style.single(field(units + i), units + i));
  for (let u = 0; u < units; u++) {
    let left = extra[u]!;
    for (const l of style.unit(field(u), u)) {
      if (typeof l === 'string') out.push(l);
      else if (left > 0) { out.push(l.opt); left--; }
    }
  }
  return out;
}

const VERB: Record<string, string> = { columns: 'column', currency: 'money', dates: 'date', escape: 'escape', format: 'format', headers: 'header',
  locale: 'localize', rows: 'row', stream: 'stream', totals: 'total', writer: 'write' };

/** One file's parts: the lines around the change, the removed and added code, and where the hunk starts. */
interface Shape { before: string[]; after: string[]; was: Style; now: Style; at: number; title: string }

function shapeOf(path: string, siblings: string[]): Shape {
  const stem = stemOf(path);
  const one = (single: (f: string, i: number) => string): Style => ({ unit: (f, i) => [single(f, i)], single });
  if (stem === 'index') {
    const others = siblings.filter((s) => s !== 'index');
    const sib = (i: number): string => others[i % others.length]!;
    return {
      before: path.startsWith('packages/contracts/') ? ["export * from './account';", "export * from './ledger';"] : [`// The public API of ${path.slice(0, path.lastIndexOf('/'))}.`],
      after: [], at: 1, title: '',
      was: one((_, i) => `export { default as ${pascal(sib(i + 3))} } from './${sib(i + 3)}';`),
      now: one((_, i) => `export * from './${sib(i)}';`),
    };
  }
  if (path.includes('/__tests__/')) {
    return {
      before: [], after: [], at: 0, title: '', was: one(() => ''),
      now: {
        unit: (f) => ['', `  it('writes the ${words(f).trim()}', () => {`, `    const csv = writeCsv([makeRow({ ${f}: sample('${f}') })], options);`,
          { opt: `    expect(csv.split('\\n')).toHaveLength(2);` }, `    expect(csv).toContain(sample('${f}'));`, '  });'],
        single: (f) => `  const ${f} = sample('${f}');`,
      },
    };
  }
  if (path.endsWith('.tsx')) {
    const progress = stem === 'ExportProgress';
    const tag = progress ? 'Progress.Step' : 'MenuItem';
    return {
      before: ['  const { start } = useExport(statementId);', '  return (', "    <Menu label={t('export.title')}>"],
      after: ['    </Menu>', '  );', '}'], at: 9, title: ` export function ${stem}({ statementId }: Props) {`,
      was: one((f) => `      <MenuItem onSelect={() => download('${f}')}>${pascal(words(f).trim())}</MenuItem>`),
      now: {
        unit: (f) => [progress ? `      <${tag} id="${f}" done={progress.done.includes('${f}')}>` : `      <${tag} onSelect={() => start('${f}')}>`,
          { opt: `        <Icon name="${kebab(f)}" />` }, `        {t('export.columns.${f}')}`, `      </${tag}>`],
        single: (f) => `      <${tag} disabled>{t('export.columns.${f}')}</${tag}>`,
      },
    };
  }
  if (path.startsWith('packages/contracts/')) {
    return {
      before: ["import { z } from 'zod';", stem === 'money' ? "import { Currency } from './currency';" : "import { Money } from './money';"],
      after: ['', 'export const CONTRACTS_VERSION = 3;'], at: 1, title: '',
      was: one((f) => `export type ${pascal(f)} = string | null;`),
      now: {
        unit: (f) => ['', `export const ${pascal(f)}Cell = z.object({`, `  key: z.literal('${f}'),`, { opt: '  label: z.string().min(1),' }, '  value: z.string().nullable(),', '});'],
        single: (f) => `export type ${pascal(f)}Cell = z.infer<typeof ${pascal(f)}Cell>;`,
      },
    };
  }
  if (path.startsWith('apps/web/')) {
    const fetches = stem === 'download' || stem === 'useExport';
    return {
      before: ["import { api } from '../api';", "import { messages, type Locale } from '../i18n';", "import { ExportError } from '@fernpay/contracts';"],
      after: ['', 'export type { Locale };'], at: 1, title: '',
      was: one((f) => `export const ${f}Label = (locale: string) => t(locale, 'columns.${f}');`),
      now: fetches ? {
        unit: (f) => ['', `export async function download${pascal(f)}(statementId: string): Promise<Blob> {`,
          `  const res = await api.get(\`/statements/\${statementId}/export?columns=${f}\`);`, { opt: '  if (!res.ok) throw new ExportError(res.status);' }, '  return res.blob();', '}'],
        single: (f) => `export const ${f}Column = '${f}';`,
      } : {
        unit: (f) => ['', `export function ${f}Label(locale: Locale): string {`, { opt: `  if (locale === 'en') return '${pascal(words(f).trim())}';` },
          `  return messages(locale).columns.${f};`, '}'],
        single: (f, i) => `export const ${f}Width = ${8 + (i * 5) % 17};`,
      },
    };
  }
  const verb = VERB[stem] ?? stem;
  return {
    before: ["import type { CsvOptions, StatementRow } from '@fernpay/contracts';", stem === 'escape' ? "import { QUOTE } from './constants';" : "import { escapeCell } from './escape';", "import { isBlank } from './blank';"],
    after: ['', 'export type { CsvOptions, StatementRow };'], at: 1, title: '',
    was: {
      unit: (f) => ['', `export function ${verb}${pascal(f)}(row: StatementRow): string {`, { opt: '  // TODO: escape the delimiter.' }, `  return row.${f} == null ? '' : String(row.${f});`, '}'],
      single: (f, i) => `export const ${constant(f)}_INDEX = ${i};`,
    },
    now: {
      unit: (f) => ['', `export function ${verb}${pascal(f)}(row: StatementRow, options: CsvOptions): string {`, `  const value = row.${f};`,
        { opt: `  // An empty ${words(f).trim()} writes options.empty, never "null".` }, '  if (isBlank(value)) return options.empty;',
        { opt: "  if (typeof value === 'object') return escapeCell(JSON.stringify(value), options.delimiter);" },
        '  return escapeCell(String(value), options.delimiter);', '}'],
      single: (f, i) => `export const ${constant(f)}_WIDTH = ${8 + (i * 5) % 17};`,
    },
  };
}

/** A new file's lines around its added code. */
function frameOf(path: string): { head: string[]; tail: string[] } {
  const stem = stemOf(path);
  if (path.includes('/__tests__/')) {
    return { head: ["import { describe, expect, it } from 'vitest';", "import { makeRow, options, sample } from '@fernpay/statements/testing';",
      "import { writeCsv } from '../writer';", '', `describe('${words(stem).trim()}', () => {`], tail: ['});'] };
  }
  if (stem === 'ExportProgress') {
    return { head: ["import { Progress } from '@fernpay/ui';", "import { useTranslation } from '../i18n';", "import { useExport } from './useExport';", '',
      'export function ExportProgress({ statementId }: { statementId: string }) {', '  const { t } = useTranslation();',
      '  const { progress } = useExport(statementId);', '  return (', '    <Progress value={progress.done.length} max={progress.total}>'],
    tail: ['    </Progress>', '  );', '}'] };
  }
  if (path.startsWith('packages/contracts/')) return { head: ["import { z } from 'zod';"], tail: [] };
  return { head: ["import { api } from '../api';", "import { ExportError } from '@fernpay/contracts';"], tail: [] };
}

const blob = (s: string): string => seed(s).toString(16).padStart(8, '0').slice(0, 7);
const lines = (mark: string, ls: readonly string[]): string[] => ls.map((l) => mark + l);

/** One file's section of the patch, with exactly `a` lines added and `d` removed. */
function section(path: string, a: number, d: number, siblings: string[]): string[] {
  const head = `diff --git a/${path} b/${path}`;
  const s = seed(path);
  // A file that only adds lines is new, except a package's index, which only gains exports.
  if (d === 0 && stemOf(path) !== 'index') {
    const { head: top, tail } = frameOf(path);
    const body = [...top, ...fill(shapeOf(path, siblings).now, a - top.length - tail.length, s % FIELDS.length), ...tail];
    if (body.length !== a) throw new Error(`demo diff: ${path} needs ${a} lines, has ${body.length}`);
    return [head, 'new file mode 100644', `index 0000000..${blob(`${path}+`)}`, '--- /dev/null', `+++ b/${path}`, `@@ -0,0 +1,${a} @@`, ...lines('+', body)];
  }
  const sh = shapeOf(path, siblings);
  const was = fill(sh.was, d, (s >>> 8) % FIELDS.length), now = fill(sh.now, a, s % FIELDS.length);
  if (was.length !== d || now.length !== a) throw new Error(`demo diff: ${path} needs -${d} +${a}, has -${was.length} +${now.length}`);
  const ctx = sh.before.length + sh.after.length;
  return [head, `index ${blob(`${path}-`)}..${blob(`${path}+`)} 100644`, `--- a/${path}`, `+++ b/${path}`,
    `@@ -${sh.at},${ctx + d} +${sh.at},${ctx + a} @@${sh.title}`, ...lines(' ', sh.before), ...lines('-', was), ...lines('+', now), ...lines(' ', sh.after)];
}

/** Iris's PR as T3 Code answers for it: the patch, and the file GitHub withheld. */
export function demoDiff(): { pr: typeof DEMO_DIFF_PR; patch: string; withheld: Withheld[] } {
  const dirOf = (p: string): string => p.slice(0, p.lastIndexOf('/'));
  const out: string[] = [];
  for (const [path, a, d] of IRIS) {
    const siblings = IRIS.filter(([p]) => dirOf(p) === dirOf(path)).map(([p]) => stemOf(p));
    out.push(...section(path, a, d, siblings));
  }
  // T3 keeps a withheld file in the patch as its header alone (gitHubPullRequestJson.ts toFilesPatch).
  out.push(`diff --git a/${LOCK.path} b/${LOCK.path}`, `--- a/${LOCK.path}`, `+++ b/${LOCK.path}`);
  return { pr: DEMO_DIFF_PR, patch: `${out.join('\n')}\n`, withheld: [LOCK] };
}
