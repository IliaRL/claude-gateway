#!/usr/bin/env node
// Lightweight, dependency-free lint for AIClient2API:
//   1. Syntax-checks every src JS file via `node --check` (sequential; never scans node_modules/.git).
//   2. Validates every configs/*.json parses.
//   3. Optionally validates the sibling Tier2-LiteLLM/litellm_config.yaml (skipped if python yaml absent).
// Exits non-zero if any category has errors. Wired as `npm run lint` / `pnpm run lint`.
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
let errors = 0;

function walkJs(dir, acc) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue; // CPU rule: never scan these
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) walkJs(p, acc);
    else if (/\.(c|m)?js$/.test(entry.name)) acc.push(p);
  }
  return acc;
}

// 1. JS syntax
const jsFiles = fs.existsSync(path.join(root, 'src')) ? walkJs(path.join(root, 'src'), []) : [];
for (const f of jsFiles) {
  try {
    execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' });
  } catch (err) {
    errors++;
    console.error(`SYNTAX ERROR: ${path.relative(root, f)}\n${(err.stderr || err.message).toString().trim()}`);
  }
}

// 2. JSON configs
const cfgDir = path.join(root, 'configs');
const jsonFiles = fs.existsSync(cfgDir)
  ? fs.readdirSync(cfgDir).filter((f) => f.endsWith('.json')).map((f) => path.join(cfgDir, f))
  : [];
for (const f of jsonFiles) {
  try {
    JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch (err) {
    errors++;
    console.error(`JSON ERROR: ${path.relative(root, f)} - ${err.message}`);
  }
}

// 3. Optional sibling LiteLLM YAML
const yamlPath = path.resolve(root, '..', 'Tier2-LiteLLM', 'litellm_config.yaml');
let yamlNote = '';
if (fs.existsSync(yamlPath)) {
  try {
    execFileSync('python3', ['-c', 'import sys,yaml; yaml.safe_load(open(sys.argv[1]))', yamlPath], { stdio: 'pipe' });
    yamlNote = ', litellm_config.yaml OK';
  } catch (err) {
    const msg = (err.stderr || err.message).toString();
    if (/No module named 'yaml'|ModuleNotFoundError/.test(msg)) {
      yamlNote = ', YAML check skipped (python yaml unavailable)';
    } else {
      errors++;
      console.error(`YAML ERROR: ${path.relative(root, yamlPath)} - ${msg.trim()}`);
    }
  }
}

console.log(`lint: ${jsFiles.length} JS files, ${jsonFiles.length} JSON configs${yamlNote} — ${errors} error(s).`);
process.exit(errors ? 1 : 0);
