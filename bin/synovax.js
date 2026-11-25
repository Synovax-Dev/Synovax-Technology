#!/usr/bin/env node
// The `synovax` command, for `npx synovax`:
//   synovax                       start a vault server on http://127.0.0.1:8787
//   synovax connector             run the connector (an MCP server over stdio)
//   synovax admin-password [pw]   reset the server's admin password
// npx keeps the package in a cache that can be cleared, so the data does not live
// next to the code here: the server keeps it in ~/.synovax (DATA_DIR changes it)
// and the connector its cache in ~/.synovax/cache (VAULT_CACHE_DIR changes it).
import os from 'node:os';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOME = path.join(os.homedir(), '.synovax');
const [cmd = 'server', ...rest] = process.argv.slice(2);

const HELP = `Usage: npx synovax [command]

  (none) or server             start a vault server on http://127.0.0.1:8787
  connector                    run the connector for an AI app (MCP over stdio)
  admin-password [password]    reset the admin password (random if not given)
  version                      print the version

Data is kept in ${HOME} (set DATA_DIR to change it).
Docs: https://synovax.tech/docs/`;

process.env.SYNOVAX_CLI = '1';
switch (cmd) {
  case 'server':
  case 'start':
    process.env.DATA_DIR ??= HOME;
    await import('../server/index.js');
    break;
  case 'connector':
    process.env.VAULT_CACHE_DIR ??= path.join(HOME, 'cache');
    await import('../connector/index.js');
    break;
  case 'admin-password': {
    process.env.DATA_DIR ??= HOME;
    const file = path.join(ROOT, 'server', 'admin-password.js');
    process.argv = [process.argv[0], file, ...rest];
    await import('../server/admin-password.js');
    break;
  }
  case 'version':
  case '--version':
  case '-v':
    console.log(JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version);
    break;
  case 'help':
  case '--help':
  case '-h':
    console.log(HELP);
    break;
  default:
    console.error(`Unknown command: ${cmd}\n\n${HELP}`);
    process.exit(1);
}
