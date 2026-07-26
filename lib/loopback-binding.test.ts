import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const read = (p: string) => readFileSync(resolve(__dirname, '..', p), 'utf8');

describe('launch paths bind to loopback', () => {
  it('docker compose publishes the frontend on 127.0.0.1 only', () => {
    expect(read('docker-compose.yml')).toContain('"127.0.0.1:3000:3000"');
  });

  it('the Apple Container path publishes on 127.0.0.1 only', () => {
    expect(read('Makefile')).toContain('--publish 127.0.0.1:3000:3000');
  });

  it('next dev and next start pin the hostname to loopback', () => {
    const pkg = JSON.parse(read('package.json'));
    expect(pkg.scripts.dev).toContain('-H 127.0.0.1');
    expect(pkg.scripts.start).toContain('-H 127.0.0.1');
  });

  it('leaves container-internal binds on 0.0.0.0', () => {
    // A process bound to loopback inside its own netns is unreachable from
    // the host publish; these must stay as they are.
    expect(read('backend/Dockerfile')).toContain('"--host", "0.0.0.0"');
    expect(read('Dockerfile')).toContain('HOSTNAME=0.0.0.0');
  });
});
