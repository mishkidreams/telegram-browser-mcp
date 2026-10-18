#!/usr/bin/env node
// Sanitize this process before dependencies capture diagnostics at module initialization.
// Playwright also accepts npm aliases for PWDEBUG and PWDEBUGIMPL.
for (const key of [
  'DEBUG', 'DEBUG_FILE', 'PWDEBUG', 'PWDEBUGIMPL', 'CHROME_LOG_FILE',
  'npm_config_pwdebug', 'npm_package_config_pwdebug',
  'npm_config_pwdebugimpl', 'npm_package_config_pwdebugimpl',
]) delete process.env[key];

await import('./cli-main.mjs');
