#!/usr/bin/env node
// Quick test: Load persona profiles with new ID logic

import { readdir, readFile } from 'fs/promises';
import { join } from 'path';

const PERSONAS_PATH = '/root/projekte/orchestrator/team/personas';

async function testPersonaLoading() {
  console.log('🔍 Testing Persona ID extraction...\n');

  const files = await readdir(PERSONAS_PATH);
  const personaFiles = files.filter(f => f.endsWith('.md'));

  console.log(`Found ${personaFiles.length} persona files\n`);

  for (const file of personaFiles.slice(0, 10)) {
    // OLD logic (buggy):
    const oldId = file.replace('.md', '').split('-')[0];

    // NEW logic (fixed):
    const newId = file.replace('.md', '');

    const content = await readFile(join(PERSONAS_PATH, file), 'utf-8');
    const nameMatch = content.match(/^# (.+?) - (.+)/m);
    const name = nameMatch ? nameMatch[1] : '?';

    console.log(`File: ${file}`);
    console.log(`  OLD ID: "${oldId}" ❌`);
    console.log(`  NEW ID: "${newId}" ✅`);
    console.log(`  Name: "${name}"`);
    console.log('');
  }
}

testPersonaLoading().catch(console.error);
