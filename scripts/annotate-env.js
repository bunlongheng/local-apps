#!/usr/bin/env node
/**
 * annotate-env.js
 * Scans .env files in ~/Sites/* and adds inline comments explaining each variable.
 * Skips any repo listed in SKIP_REPOS below.
 *
 * Usage:
 *   node scripts/annotate-env.js              # dry-run (preview)
 *   node scripts/annotate-env.js --write      # write changes
 *   node scripts/annotate-env.js bheng        # single repo dry-run
 *   node scripts/annotate-env.js bheng --write # single repo write
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const SITES_DIR = path.join(os.homedir(), 'Sites');

// Repos to skip (add your own)
const SKIP_REPOS = new Set([
  'notes', 'node_modules',
]);

// --- Known variable patterns → short descriptions ---
// Order matters: first match wins. Use regex patterns.
const PATTERNS = [
  // App basics
  [/^APP_NAME$/,                  'Application display name'],
  [/^APP_ENV$/,                   'Environment: local/staging/production'],
  [/^APP_KEY$/,                   'Laravel encryption key'],
  [/^APP_DEBUG$/,                 'Enable debug mode (true/false)'],
  [/^APP_URL$/,                   'Application base URL'],
  [/^APP_TIMEZONE$/,              'Application timezone'],
  [/^APP_CIPHER$/,                'Encryption cipher algorithm'],
  [/^APP_BASE_URL$/,              'Application base URL'],
  [/^PROD_BASE_URL$/,             'Production base URL'],
  [/^NODE_ENV$/,                  'Node environment: development/production'],
  [/^ANALYZE$/,                   'Enable bundle analyzer'],

  // Next.js / Vercel
  [/^NEXT_PUBLIC_APP_BASE_URL$/,  'Public-facing app base URL'],
  [/^NEXT_PUBLIC_DEPLOY_TIME$/,   'Build timestamp for cache busting'],
  [/^NEXT_PUBLIC_GIT_SHA$/,       'Git commit SHA for version tracking'],
  [/^NEXT_PUBLIC_GA_ID$/,         'Google Analytics measurement ID'],
  [/^VERCEL_TOKEN$/,              'Vercel API auth token'],
  [/^VERCEL_PROJECT_ID$/,         'Vercel project identifier'],
  [/^VERCEL_OIDC_TOKEN$/,         'Vercel OIDC token for deployments'],
  [/^NEXTAUTH_URL$/,              'NextAuth callback base URL'],
  [/^NEXTAUTH_SECRET$/,           'NextAuth JWT signing secret'],

  // Supabase
  [/^NEXT_PUBLIC_SUPABASE_URL$/,  'Supabase project URL'],
  [/^NEXT_PUBLIC_SUPABASE_ANON_KEY$/, 'Supabase public anon key'],
  [/^SUPABASE_SERVICE_ROLE_KEY$/, 'Supabase admin service role key'],
  [/^SUPABASE_PROJECT_REF$/,      'Supabase project reference ID'],
  [/^VITE_SUPABASE_URL$/,         'Supabase project URL (Vite)'],
  [/^VITE_SUPABASE_ANON_KEY$/,    'Supabase public anon key (Vite)'],

  // Database
  [/^DATABASE_URL$/,              'PostgreSQL connection string'],
  [/^DB_CONNECTION$/,             'Database driver (mysql/pgsql/sqlite)'],
  [/^DB_HOST$/,                   'Database server hostname'],
  [/^DB_PORT$/,                   'Database server port'],
  [/^DB_DATABASE$/,               'Database name'],
  [/^DB_DATABASE_\w+$/,           'Additional database name'],
  [/^DB_USERNAME$/,               'Database auth username'],
  [/^DB_PASSWORD$/,               'Database auth password'],

  // Redis
  [/^REDIS_CLIENT$/,              'Redis client library (phpredis/predis)'],
  [/^REDIS_HOST$/,                'Redis server hostname'],
  [/^REDIS_PORT$/,                'Redis server port'],
  [/^REDIS_PASSWORD$/,            'Redis auth password'],

  // Auth / OAuth
  [/^ADMIN_EMAIL$/,               'Admin user email address'],
  [/^OWNER_EMAIL$/,               'Owner email for access control'],
  [/^ALLOWED_EMAIL$/,             'Email whitelist for login'],
  [/^CLIENT_ID$/,                 'OAuth client ID'],
  [/^CLIENT_SECRET$/,             'OAuth client secret'],
  [/^REDIRECT_URI$/,              'OAuth redirect callback URL'],
  [/^AUTH_CODE$/,                 'OAuth authorization code'],
  [/^AUTH_TOKEN$/,                'API auth bearer token'],
  [/^ACCESS_TOKEN$/,              'OAuth access token'],
  [/^REFRESH_TOKEN$/,             'OAuth refresh token'],
  [/^CAS_TOKEN$/,                 'CAS authentication token'],
  [/^TOKEN$/,                     'API auth token'],

  // Google
  [/^GOOGLE_CLIENT_ID$/,          'Google OAuth client ID'],
  [/^GOOGLE_CLIENT_SECRET$/,      'Google OAuth client secret'],
  [/^GOOGLE_WEB_API_KEY$/,        'Google API key (web)'],
  [/^GOOGLE_SERVICE_ACCOUNT_JSON$/, 'Google service account credentials JSON'],
  [/^GOOGLE_DRIVE_PARENT_FOLDER_ID$/, 'Google Drive target folder ID'],
  [/^NEXT_PUBLIC_GOOGLE_MAPS_API_KEY$/, 'Google Maps JavaScript API key'],
  [/^GMAIL_CLIENT_ID$/,           'Gmail OAuth client ID'],
  [/^GMAIL_CLIENT_SECRET$/,       'Gmail OAuth client secret'],
  [/^GMAIL_REFRESH_TOKEN$/,       'Gmail OAuth refresh token'],

  // Pusher
  [/^PUSHER_APP_ID$/,             'Pusher app ID for WebSocket'],
  [/^PUSHER_(APP_)?KEY$/,         'Pusher app key'],
  [/^PUSHER_(APP_)?SECRET$/,      'Pusher app secret'],
  [/^PUSHER_(APP_)?CLUSTER$/,     'Pusher cluster region'],
  [/^NEXT_PUBLIC_PUSHER_KEY$/,    'Pusher key (client-side)'],
  [/^NEXT_PUBLIC_PUSHER_CLUSTER$/,'Pusher cluster (client-side)'],

  // Mail
  [/^MAIL_MAILER$/,               'Mail transport driver (smtp/ses/log)'],
  [/^MAIL_DRIVER$/,               'Mail transport driver'],
  [/^MAIL_HOST$/,                 'SMTP server hostname'],
  [/^MAIL_PORT$/,                 'SMTP server port'],
  [/^MAIL_USERNAME$/,             'SMTP auth username'],
  [/^MAIL_PASSWORD$/,             'SMTP auth password'],
  [/^MAIL_ENCRYPTION$/,           'SMTP encryption (tls/ssl)'],
  [/^MAIL_FROM(_ADDRESS)?$/,      'Default sender email'],
  [/^MAIL_FROM_NAME$/,            'Default sender name'],
  [/^MAIL_TO$/,                   'Default recipient email'],

  // AWS
  [/^AWS_ACCESS_KEY_ID$/,         'AWS IAM access key'],
  [/^AWS_SECRET_ACCESS_KEY$/,     'AWS IAM secret key'],
  [/^AWS_DEFAULT_REGION$/,        'AWS region (e.g. us-east-1)'],
  [/^AWS_BUCKET$/,                'AWS S3 bucket name'],
  [/^AWS_URL$/,                   'AWS S3 base URL'],
  [/^AWS_JS_URL$/,                'AWS S3 URL for JS assets'],

  // AI
  [/^ANTHROPIC_API_KEY$/,         'Claude API key'],
  [/^OPENAI_API_KEY$/,            'OpenAI API key'],
  [/^AI_API_SECRET$/,             'AI endpoint auth secret'],

  // Laravel / PHP
  [/^LOG_CHANNEL$/,               'Laravel log channel (stack/daily/single)'],
  [/^BROADCAST_DRIVER$/,          'Laravel broadcast driver (pusher/redis/log)'],
  [/^CACHE_DRIVER$/,              'Cache backend (file/redis/memcached)'],
  [/^CACHE_STORE$/,               'Cache store name'],
  [/^QUEUE_CONNECTION$/,          'Queue backend (sync/redis/sqs)'],
  [/^QUEUE_DRIVER$/,              'Queue driver'],
  [/^SESSION_DRIVER$/,            'Session backend (file/redis/cookie)'],
  [/^SESSION_LIFETIME$/,          'Session TTL in minutes'],
  [/^SESSION_DOMAIN$/,            'Cookie domain for sessions'],
  [/^SESSION_SECURE_COOKIE$/,     'HTTPS-only session cookie'],
  [/^SESSION_HTTP_ONLY$/,         'HTTP-only session cookie flag'],
  [/^SESSION_SAME_SITE$/,         'SameSite cookie policy (lax/strict/none)'],

  // STS / 3PI
  [/^STS_ISSUER$/,                'Security token service issuer URL'],
  [/^STS_AUDIENCE$/,              'STS token audience identifier'],
  [/^STS_TOKEN_TTL_SECONDS$/,     'STS token time-to-live in seconds'],
  [/^STS_PRIVATE_KEY_PATH$/,      'Path to STS RSA private key'],
  [/^STS_PUBLIC_KEY_PATH$/,       'Path to STS RSA public key'],
  [/^STS_SERVICE_KEY$/,           'STS service authentication key'],

  // App-specific
  [/^URL$/,                       'API base URL'],
  [/^TENANT_ID$/,                 'Tenant/account identifier'],
  [/^BHENG_BASE_URL$/,            'bheng.dev API base URL'],
  [/^STICKIES_API_KEY$/,          'Stickies app API key'],
  [/^STICKIES_PASSWORD$/,         'Stickies app auth password'],
  [/^TOOLS_USERNAME$/,            'Tools app auth username'],
  [/^TOOLS_PASSWORD$/,            'Tools app auth password'],
  [/^PM2020_BASE_URL$/,           'PM2020 API base URL'],
  [/^PM2020_USERNAME$/,           'PM2020 auth username'],
  [/^PM2020_PASSWORD$/,           'PM2020 auth password'],
  [/^SAFE_API_KEY$/,              'Safe app remote access API key'],
  [/^RUN_KEY$/,                   'Auth key for cron/run endpoints'],
  [/^DOWNLOAD_KEY$/,              'Auth key for download endpoints'],
  [/^LOG_PW$/,                    'Log viewer auth password'],
  [/^PURGE_LIMIT$/,               'Max records to purge per run'],
  [/^PURGE_EMAIL_TO$/,            'Email recipient for purge reports'],
  [/^MY_IP$/,                     'Whitelisted IP address'],
  [/^ROTH_PHONE$/,                'Phone number (Roth)'],
  [/^LONG_PHONE$/,                'Phone number (Long)'],
  [/^CONSOLE_USER_NAME$/,         'Admin console username'],
  [/^CONSOLE_USER_PASSWORD$/,     'Admin console password'],
  [/^NX_ADD_PLUGINS$/,            'NX auto-plugin detection toggle'],

  // Social / Third-party
  [/^INSTAGRAM_ACCESS_TOKEN$/,    'Instagram Graph API access token'],
  [/^NOCAPTCHA_SITEKEY$/,         'Google reCAPTCHA site key'],
  [/^NOCAPTCHA_SECRET$/,          'Google reCAPTCHA secret key'],
  [/^IMGUR_CLIENT_ID$/,           'Imgur API client ID'],
  [/^IMGUR_CLIENT_SECRET$/,       'Imgur API client secret'],
  [/^IMGUR_REFRESH_TOKEN$/,       'Imgur API refresh token'],
  [/^API_FOOTBALL_KEY$/,          'Football API auth key'],

  // React
  [/^REACT_APP_CATEGORIES$/,     'App content categories config'],
  [/^REACT_APP_TRANSPORTATION_TYPES$/, 'Transportation type options'],
  [/^REACT_APP_UNSPLASH_KEY$/,   'Unsplash image API key'],

  // Vue / Sentry
  [/^VUE_APP_SENTRY_\w+$/,       'Sentry error tracking config'],
  [/^VUE_APP_\w+$/,              'Vue app config variable'],
];

// --- Match a variable name to a description ---
function describe(varName) {
  for (const [regex, desc] of PATTERNS) {
    if (regex.test(varName)) return desc;
  }
  return null;
}

// --- Process a single .env file ---
function processEnvFile(filePath, dryRun) {
  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.split('\n');
  let modified = false;
  const annotated = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Skip empty lines, comments, commented-out vars
    if (!line.trim() || line.trim().startsWith('#')) {
      annotated.push(line);
      continue;
    }

    // Parse KEY=value
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)/);
    if (!match) {
      annotated.push(line);
      continue;
    }

    const [, varName, value] = match;

    // Already has inline comment?
    if (value.includes(' #')) {
      annotated.push(line);
      continue;
    }

    // Check if previous line is already a comment for this var
    const prevLine = i > 0 ? lines[i - 1].trim() : '';
    if (prevLine.startsWith('#') && !prevLine.startsWith('# ---') && !prevLine.startsWith('#!')) {
      // Previous line is a comment — skip adding another
      annotated.push(line);
      continue;
    }

    const desc = describe(varName);
    if (desc) {
      annotated.push(`${line} # ${desc}`);
      modified = true;
    } else {
      annotated.push(line);
    }
  }

  if (modified) {
    const result = annotated.join('\n');
    if (dryRun) {
      return { filePath, status: 'would_write', changes: annotated.filter((l, i) => l !== lines[i]).length };
    } else {
      fs.writeFileSync(filePath, result, 'utf8');
      return { filePath, status: 'written', changes: annotated.filter((l, i) => l !== lines[i]).length };
    }
  }

  return { filePath, status: 'no_changes', changes: 0 };
}

// --- Main ---
function main() {
  const args = process.argv.slice(2);
  const writeMode = args.includes('--write');
  const targetRepo = args.find(a => a !== '--write') || null;

  console.log(`\n🔍 Env Annotator (${writeMode ? 'WRITE mode' : 'dry-run, use --write to apply'})\n`);

  // Find all .env files
  const results = [];
  const dirs = fs.readdirSync(SITES_DIR, { withFileTypes: true })
    .filter(d => d.isDirectory() && !d.name.startsWith('.') && !SKIP_REPOS.has(d.name));

  for (const dir of dirs) {
    if (targetRepo && dir.name !== targetRepo) continue;

    const repoPath = path.join(SITES_DIR, dir.name);
    // Find .env files up to 3 levels deep
    findEnvFiles(repoPath, 0, 3).forEach(envFile => {
      try {
        const result = processEnvFile(envFile, !writeMode);
        results.push(result);
        const icon = result.status === 'no_changes' ? '⏭ ' : result.status === 'written' ? '✅' : '📝';
        console.log(`  ${icon} ${path.relative(SITES_DIR, envFile)} — ${result.changes} annotations ${result.status === 'written' ? 'written' : result.status === 'would_write' ? '(preview)' : '(already annotated)'}`);
      } catch (err) {
        console.error(`  ❌ ${path.relative(SITES_DIR, envFile)}: ${err.message}`);
      }
    });
  }

  const total = results.reduce((s, r) => s + r.changes, 0);
  console.log(`\n📊 ${results.length} files scanned, ${total} annotations ${writeMode ? 'written' : 'to add'}\n`);
}

function findEnvFiles(dir, depth, maxDepth) {
  if (depth > maxDepth) return [];
  const files = [];
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === '.next' || entry.name === '.git' || entry.name === 'dist' || entry.name === '.vercel') continue;
      const full = path.join(dir, entry.name);
      if (entry.isFile() && entry.name.startsWith('.env')) {
        files.push(full);
      } else if (entry.isDirectory() && depth < maxDepth) {
        files.push(...findEnvFiles(full, depth + 1, maxDepth));
      }
    }
  } catch {}
  return files.sort();
}

main();
