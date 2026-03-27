#!/usr/bin/env node

import assert from 'node:assert/strict';
import { loadOpenClawPlugins } from '/opt/openclaw/versions/v2026.3.24/src/plugins/loader.ts';

const pluginPath = new URL('../index.ts', import.meta.url).pathname;

const registry = loadOpenClawPlugins({
  cache: false,
  workspaceDir: '/home/ubuntu/public-deliverables/mission-runner',
  config: {
    plugins: {
      load: { paths: [pluginPath] },
      allow: ['mission-runner'],
      entries: {
        'mission-runner': {
          config: {
            missionsDir: 'smoke-missions',
          },
        },
      },
    },
  },
});

const pluginRecord = registry.plugins.find((entry) => entry.id === 'mission-runner');
assert.equal(pluginRecord?.status, 'loaded', 'mission-runner plugin should load successfully');

const toolNames = registry.tools
  .filter((entry) => entry.pluginId === 'mission-runner')
  .flatMap((entry) => entry.names);

assert.ok(toolNames.includes('mission_start'), 'mission_start should be registered');
assert.ok(toolNames.includes('mission_task_update'), 'mission_task_update should be registered');

console.log(JSON.stringify({
  pluginId: pluginRecord?.id,
  status: pluginRecord?.status,
  toolCount: toolNames.length,
  toolNames,
}, null, 2));
