/**
 * SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Fernando Rijo Cedeno
 */
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const fs = require('node:fs');
const { createRequire } = require('node:module');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../server');

async function main(args = process.argv.slice(2)) {
  if (args.includes('--help')) {
    console.log('Usage: npm run test:zowe-mq -- [path/to/zowe/mq]\nDefaults to ~/gh/zowe/mq. Install the plug-in dependencies with npm ci first.');
    return 0;
  }
  if (args.length > 1 || args[0]?.startsWith('-')) throw new Error('Expected one MQ plug-in checkout path; use --help for usage.');
  const project = path.resolve(args[0] || path.join(os.homedir(), 'gh/zowe/mq'));
  const packagePath = path.join(project, 'package.json');
  if (!fs.existsSync(packagePath)) throw new Error(`MQ plug-in checkout not found: ${project}`);
  const requirePlugin = createRequire(packagePath);
  const manifest = requirePlugin(packagePath);
  if (manifest.name !== '@zowe/mq-for-zowe-cli' || !manifest.scripts?.['test:system']) throw new Error('Expected the @zowe/mq-for-zowe-cli checkout with its test:system script.');
  let tsc, yaml;
  try {
    tsc = requirePlugin.resolve('typescript/bin/tsc');
    requirePlugin.resolve('@zowe/cli');
    yaml = requirePlugin('js-yaml');
  } catch {
    throw new Error(`Install the MQ plug-in dependencies first: npm ci in ${project}`);
  }
  const properties = yaml.load(fs.readFileSync(path.join(project, '__tests__/__resources__/properties/example_properties.yaml'), 'utf8'));
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'mq-rest-zowe-'));
  const checkout = path.join(temporary, 'mq');
  let server, child, interrupted = 0;
  const interrupt = () => { interrupted = 130; child?.kill('SIGINT'); };
  const terminate = () => { interrupted = 143; child?.kill('SIGTERM'); };
  process.on('SIGINT', interrupt); process.on('SIGTERM', terminate);
  try {
    fs.mkdirSync(checkout);
    // Copy only public sources and test fixtures; keep generated files and local profiles isolated.
    for (const entry of ['package.json', 'tsconfig.json', 'src', '__tests__', 'LICENSE', 'README.md']) {
      const source = path.join(project, entry);
      if (!fs.existsSync(source)) continue;
      fs.cpSync(source, path.join(checkout, entry), {
        recursive: true,
        filter: file => !file.split(path.sep).includes('__results__') &&
          (!file.includes(`${path.sep}properties${path.sep}`) || path.basename(file) === 'example_properties.yaml')
      });
    }
    fs.symlinkSync(path.join(project, 'node_modules'), path.join(checkout, 'node_modules'), 'dir');
    const app = createApp({ config: { mqscResponseStyle: 'zos' } });
    server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    properties.mq = {
      host: '127.0.0.1', port: server.address().port, protocol: 'http',
      user: 'adminusr', password: 'adminpas', qmgr: 'QM1', rejectUnauthorized: false
    };
    // JSON is also valid YAML. The test commands and expectations come directly from the plug-in.
    fs.writeFileSync(path.join(temporary, 'mock_properties.yaml'), JSON.stringify(properties, null, 2));
    const env = {
      ...process.env, PATH: `${path.join(project, 'node_modules/.bin')}${path.delimiter}${process.env.PATH || ''}`,
      propdirectory: `${temporary}${path.sep}`, propfile: 'mock_properties.yaml', FORCE_COLOR: '0',
      npm_config_audit: 'false', npm_config_fund: 'false', npm_config_update_notifier: 'false'
    };
    // Zowe's test utilities set FORCE_COLOR; Node warns on stderr if NO_COLOR is also present.
    delete env.NO_COLOR;
    async function run(command, commandArgs) {
      if (interrupted) return interrupted;
      child = spawn(command, commandArgs, { cwd: checkout, env, stdio: 'inherit' });
      const [code, signal] = await once(child, 'exit');
      child = undefined;
      return code ?? (signal === 'SIGINT' ? 130 : 143);
    }
    console.log(`Building the MQ plug-in in ${checkout}`);
    const buildCode = await run(process.execPath, [tsc, '--project', 'tsconfig.json']);
    if (buildCode !== 0) return buildCode;
    console.log(`Running unchanged MQ system tests against http://127.0.0.1:${server.address().port}`);
    return await run('npm', ['run', 'test:system', '--', '--testTimeout=60000']);
  } finally {
    process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', terminate);
    if (server) {
      await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    }
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}
if (require.main === module) main().then(code => { process.exitCode = code; }).catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { main };
