#!/usr/bin/env node
// Presence checks only: never print credential values.
import { readFileSync, statSync } from 'node:fs';
const path = `${process.argv[2]}/.meeting-copilot.env`;
let file = '';
try { file = readFileSync(path, 'utf8'); } catch {}
for (const name of ['GASTROBRAIN_API_URL', 'MEETING_AGENT_TOKEN', 'MEETING_COPILOT_OPERATOR_EMAIL']) {
  const line = file.split('\n').find(line => new RegExp(`^\\s*(?:export\\s+)?${name}=`).test(line));
  if (!process.env[name]?.trim() && !line?.split('=').slice(1).join('=').replace(/["']/g, '').trim()) console.log(name);
}
try { if ((statSync(path).mode & 0o077) !== 0) console.log('.meeting-copilot.env permissions (use chmod 600)'); } catch {}
