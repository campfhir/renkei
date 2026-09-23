/**
 * The Docker client's pure edges: where the engine is read from, the
 * registry credential header, the pull stream's error lines, the log
 * stream's frames, and a memory size.
 */

import {
  demultiplexLogs,
  parseDockerHost,
  parseMemoryBytes,
  pullStreamError,
  registryAuthHeader,
} from './docker';

describe('parseDockerHost', () => {
  it('defaults to the engine socket and reads a socket, a path or tcp', () => {
    expect(parseDockerHost(undefined)).toEqual({ socketPath: '/var/run/docker.sock' });
    expect(parseDockerHost('unix:///run/docker.sock')).toEqual({ socketPath: '/run/docker.sock' });
    expect(parseDockerHost('/var/run/docker.sock')).toEqual({ socketPath: '/var/run/docker.sock' });
    expect(parseDockerHost('tcp://docker-proxy:2375')).toEqual({
      host: 'docker-proxy',
      port: 2375,
    });
    expect(parseDockerHost('tcp://docker-proxy')).toEqual({ host: 'docker-proxy', port: 2375 });
    expect(() => parseDockerHost('ssh://somewhere')).toThrow(/SANDBOX_DOCKER_HOST/);
  });
});

describe('registryAuthHeader', () => {
  it('is the credential as base64url JSON', () => {
    const header = registryAuthHeader({
      username: 'sp',
      password: 'p@ss/+=',
      serveraddress: 'x.azurecr.io',
    });
    expect(header).not.toMatch(/[+/=]/);
    expect(JSON.parse(Buffer.from(header, 'base64url').toString('utf8'))).toEqual({
      username: 'sp',
      password: 'p@ss/+=',
      serveraddress: 'x.azurecr.io',
    });
  });
});

describe('pullStreamError', () => {
  it('finds the error line among progress lines', () => {
    const body = [
      '{"status":"Pulling from library/postgres","id":"16"}',
      '{"status":"Pulling fs layer","progressDetail":{},"id":"abc"}',
      'not json at all',
      '{"errorDetail":{"message":"manifest unknown"},"error":"manifest for postgres:99 not found: manifest unknown"}',
    ].join('\n');
    expect(pullStreamError(body)).toBe('manifest for postgres:99 not found: manifest unknown');
    expect(pullStreamError('{"status":"Status: Downloaded newer image"}\n')).toBeNull();
    expect(pullStreamError('')).toBeNull();
  });
});

describe('demultiplexLogs', () => {
  function frame(stream: number, text: string): Buffer {
    const payload = Buffer.from(text, 'utf8');
    const header = Buffer.alloc(8);
    header[0] = stream;
    header.writeUInt32BE(payload.length, 4);
    return Buffer.concat([header, payload]);
  }

  it('strips the frame headers and keeps the order', () => {
    const raw = Buffer.concat([
      frame(1, 'starting\n'),
      frame(2, 'warning: x\n'),
      frame(1, 'ready\n'),
    ]);
    expect(demultiplexLogs(raw)).toBe('starting\nwarning: x\nready\n');
  });

  it('passes an unframed (TTY) stream through, and an empty one', () => {
    expect(demultiplexLogs(Buffer.from('plain text\n'))).toBe('plain text\n');
    expect(demultiplexLogs(Buffer.alloc(0))).toBe('');
  });

  it('tolerates a truncated last frame', () => {
    const raw = Buffer.concat([frame(1, 'ok\n'), frame(1, 'cut off here').subarray(0, 12)]);
    expect(demultiplexLogs(raw)).toBe('ok\ncut ');
  });
});

describe('parseMemoryBytes', () => {
  it('reads docker-style sizes and falls back when unset', () => {
    expect(parseMemoryBytes(undefined, 5)).toBe(5);
    expect(parseMemoryBytes('', 5)).toBe(5);
    expect(parseMemoryBytes('512m', 0)).toBe(512 * 1_048_576);
    expect(parseMemoryBytes('2G', 0)).toBe(2 * 1_073_741_824);
    expect(parseMemoryBytes('1.5g', 0)).toBe(Math.floor(1.5 * 1_073_741_824));
    expect(parseMemoryBytes('4096', 0)).toBe(4096);
    expect(() => parseMemoryBytes('lots', 0)).toThrow(/memory size/);
  });
});
