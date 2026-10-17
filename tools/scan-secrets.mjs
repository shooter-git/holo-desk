// Keeps secrets and personal details out of the repository. Run by the pre-commit hook on what is
// about to be committed (`--staged`), and by CI on every tracked file (`--all`).
//
// It looks for keys and tokens, private keys, email addresses (other than GitHub's noreply ones and
// example addresses), home-folder paths and tailnet machine names. Your own extra patterns (your
// name, your domain…) can go in .scan-secrets.local, one regular expression per line; that file is
// never committed. A line that must stay as it is can say "scan-secrets: allow".
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

const mode = process.argv.includes('--all') ? 'all' : 'staged';
const SELF = 'tools/scan-secrets.mjs';

const RULES = [
  ['private key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['AWS access key', /\bAKIA[0-9A-Z]{16}\b/],
  ['GitHub token', /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{60,})\b/],
  ['Anthropic API key', /\bsk-ant-[A-Za-z0-9_-]{20,}/],
  ['OpenAI API key', /\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}/],
  ['Slack token', /\bxox[abprs]-[A-Za-z0-9-]{10,}/],
  ['Tailscale key', /\btskey-[a-z]+-[A-Za-z0-9-]{10,}/],
  ['Google API key', /\bAIza[0-9A-Za-z_-]{35}\b/],
  ['Stripe live key', /\b[rs]k_live_[0-9a-zA-Z]{20,}/],
  [
    'password or key in the code',
    /\b(?:password|passwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token)\b["']?\s*[:=]\s*["'][^"'\s$<{]{12,}["']/i,
  ],
  ['home-folder path', /(?:\/home\/[a-z_][a-z0-9_.-]*\/|\/Users\/[^/\s"'`]+\/|[A-Z]:\\Users\\)/],
  ['tailnet machine name', /\b[a-z0-9-]+\.tail[0-9a-f]{4,}\.ts\.net\b/i],
];

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
const ALLOWED_EMAIL =
  /(@users\.noreply\.github\.com|^noreply@anthropic\.com|@example\.(com|org|net)|^git@github\.com)$/i;

const local = existsSync('.scan-secrets.local')
  ? readFileSync('.scan-secrets.local', 'utf8')
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#'))
      .map((l) => ['your own pattern', new RegExp(l, 'i')])
  : [];

const git = (...args) => execFileSync('git', args, { encoding: 'buffer', maxBuffer: 1 << 28 });

const files =
  mode === 'all'
    ? git('ls-files', '-z').toString().split('\0').filter(Boolean)
    : git('diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z').toString().split('\0').filter(Boolean);

const findings = [];
for (const file of files) {
  if (file === SELF) continue;
  let content;
  try {
    content = mode === 'all' ? readFileSync(file) : git('show', `:${file}`);
  } catch {
    continue;
  }
  if (content.subarray(0, 8000).includes(0)) continue; // binary
  const lines = content.toString('utf8').split('\n');
  lines.forEach((line, i) => {
    if (line.includes('scan-secrets: allow')) return;
    for (const [kind, re] of [...RULES, ...local]) {
      const m = re.exec(line);
      if (m) findings.push({ file, line: i + 1, kind, match: m[0] });
    }
    for (const m of line.matchAll(EMAIL)) {
      if (!ALLOWED_EMAIL.test(m[0])) findings.push({ file, line: i + 1, kind: 'email address', match: m[0] });
    }
  });
}

// Commits carry their author's email: it must be GitHub's private noreply address.
if (mode === 'staged') {
  const ident = execFileSync('git', ['var', 'GIT_AUTHOR_IDENT'], { encoding: 'utf8' });
  const email = /<([^>]*)>/.exec(ident)?.[1] ?? '';
  if (!/@users\.noreply\.github\.com$/i.test(email) && !process.env.HOLO_ALLOW_AUTHOR_EMAIL) {
    console.error(
      "This commit would publish your email address. Use GitHub's private one:\n" +
        '  git config user.email "<id>+<username>@users.noreply.github.com"\n' +
        '(GitHub → Settings → Emails shows it.) To commit with this address anyway, set HOLO_ALLOW_AUTHOR_EMAIL=1.',
    );
    process.exit(1);
  }
}

if (findings.length) {
  const mask = (s) => (s.length <= 8 ? '****' : `${s.slice(0, 4)}…${s.slice(-2)}`);
  console.error(`Found ${findings.length} thing(s) that must not be committed:`);
  for (const f of findings) console.error(`  ${f.file}:${f.line}  ${f.kind}  (${mask(f.match)})`);
  console.error('Move secrets to .env (never committed), or mark a line that is fine with "scan-secrets: allow".');
  process.exit(1);
}
console.log(`Secrets check: ${files.length} file(s) clean.`);
