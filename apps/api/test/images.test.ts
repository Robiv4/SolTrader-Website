/**
 * Token logo proxy safety + profile pictures + positions list completeness.
 */
import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';

import { hashPassword } from '../src/auth.js';
import { prisma } from '../src/database.js';
import { allowedImageUrl, createTokenImageProxy, parseAvatarDataUrl, sniffImage } from '../src/images.js';

const { app } = await import('../src/app.js');

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const SVG = new globalThis.TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
const MINT = 'So1aNaMint1111111111111111111111111111111pump';

function response(body: Uint8Array, status = 200, headers: Record<string, string> = {}) {
  return new globalThis.Response(body.length ? Buffer.from(body) : null, { status, headers });
}

describe('token image proxy', () => {
  it('only https + allowlisted hosts; ipfs:// normalised; no credentials / ports / internal hosts', () => {
    expect(allowedImageUrl('https://dd.dexscreener.com/ds-data/tokens/solana/x.png')?.hostname).toBe('dd.dexscreener.com');
    expect(allowedImageUrl('ipfs://QmAbc')?.toString()).toBe('https://ipfs.io/ipfs/QmAbc');
    for (const bad of ['http://ipfs.io/ipfs/x', 'https://evil.example.com/x.png', 'https://169.254.169.254/latest', 'https://localhost/x', 'https://user:pw@ipfs.io/x', 'https://ipfs.io:8443/x', 'javascript:alert(1)', 'data:image/png;base64,AAAA']) {
      expect(allowedImageUrl(bad)).toBeNull();
    }
  });

  it('serves only real raster images (SVG / HTML refused by content sniffing)', async () => {
    expect(sniffImage(PNG)).toBe('image/png');
    expect(sniffImage(SVG)).toBeNull();
    const calls: string[] = [];
    const proxy = createTokenImageProxy({
      prisma: { token: { findUnique: async () => ({ imageUrl: 'https://ipfs.io/ipfs/svg' }) }, launchCandidate: { findUnique: async () => null } } as never,
      fetcher: async (url) => {
        calls.push(url);
        return url.includes('svg') ? response(SVG, 200, { 'content-type': 'image/png' }) : response(PNG, 200, { 'content-type': 'image/png' });
      },
    });
    // The SVG (even mislabelled as PNG) is skipped; the DexScreener CDN fallback PNG is served.
    const image = await proxy(MINT);
    expect(image?.mime).toBe('image/png');
    expect(calls).toEqual(['https://ipfs.io/ipfs/svg', `https://dd.dexscreener.com/ds-data/tokens/solana/${MINT}.png`]);
    // Cached: no second fetch.
    await proxy(MINT);
    expect(calls).toHaveLength(2);
  });

  it('redirects must stay on allowlisted hosts', async () => {
    const calls: string[] = [];
    const proxy = createTokenImageProxy({
      prisma: { token: { findUnique: async () => ({ imageUrl: 'https://ipfs.io/ipfs/redirect' }) }, launchCandidate: { findUnique: async () => null } } as never,
      fetcher: async (url) => {
        calls.push(url);
        if (url.includes('redirect')) return response(new Uint8Array(), 302, { location: 'http://127.0.0.1:6379/' });
        return response(new Uint8Array(), 404);
      },
    });
    expect(await proxy(MINT)).toBeNull();
    expect(calls.some((url) => url.includes('127.0.0.1'))).toBe(false);
  });
});

describe('profile pictures and positions list', () => {
  const email = `images-${Date.now()}@soltrader.local`;
  const password = 'ImagesPass123!';
  afterAll(async () => {
    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) return;
    await prisma.position.deleteMany({ where: { userId: user.id } });
    await prisma.auditLog.deleteMany({ where: { userId: user.id } });
    await prisma.user.delete({ where: { id: user.id } });
    // The test token is removed again unless something else references it.
    await prisma.token.deleteMany({ where: { address: MINT, positions: { none: {} }, trades: { none: {} }, signals: { none: {} }, riskAssessments: { none: {} } } }).catch(() => undefined);
  });

  it('avatar validation: PNG / JPEG / WebP only, magic bytes must match, size capped', () => {
    expect('error' in parseAvatarDataUrl(`data:image/png;base64,${Buffer.from(PNG).toString('base64')}`)).toBe(false);
    expect(parseAvatarDataUrl(`data:image/svg+xml;base64,${Buffer.from(SVG).toString('base64')}`)).toMatchObject({ error: expect.any(String) });
    expect(parseAvatarDataUrl(`data:image/png;base64,${Buffer.from(SVG).toString('base64')}`)).toMatchObject({ error: expect.any(String) });
    expect(parseAvatarDataUrl(`data:image/png;base64,${Buffer.alloc(250_000, 1).toString('base64')}`)).toMatchObject({ error: expect.any(String) });
  });

  it('upload / read / remove own avatar; other users cannot read it; every OPEN position is listed', async () => {
    const user = await prisma.user.create({ data: { email, passwordHash: await hashPassword(password), role: 'USER' } });
    const agent = request.agent(app);
    expect((await agent.post('/api/auth/login').send({ email, password })).status).toBe(200);
    const upload = await agent.put('/api/profile/avatar').send({ image: `data:image/png;base64,${Buffer.from(PNG).toString('base64')}` });
    expect(upload.status).toBe(200);
    const me = await agent.get('/api/auth/me');
    expect(me.body.data.avatarVersion).toBe(upload.body.data.avatarVersion);
    const image = await agent.get(`/api/users/${user.id}/avatar`);
    expect(image.status).toBe(200);
    expect(image.headers['content-type']).toBe('image/png');
    expect(image.headers['x-content-type-options']).toBe('nosniff');
    // Another (non-admin) account cannot read it.
    const admin = await prisma.user.findFirst({ where: { role: 'ADMIN' }, select: { id: true } });
    if (admin) expect((await agent.get(`/api/users/${admin.id}/avatar`)).status).toBe(403);
    expect((await agent.delete('/api/profile/avatar').send({})).status).toBe(200);
    expect((await agent.get(`/api/users/${user.id}/avatar`)).status).toBe(404);

    // 30 newer closed positions + 1 old open one: the open one must still be listed (default limit is 25).
    const token = await prisma.token.upsert({ where: { address: MINT }, update: {}, create: { address: MINT, symbol: 'IMG' } });
    const base = Date.now() - 3_600_000;
    await prisma.position.create({ data: { userId: user.id, tokenId: token.id, side: 'BUY', quantity: 1, avgEntryPrice: 1, currentPrice: 1, status: 'OPEN', mode: 'PAPER', openedAt: new Date(base) } });
    for (let index = 0; index < 30; index += 1) {
      await prisma.position.create({ data: { userId: user.id, tokenId: token.id, side: 'BUY', quantity: 1, avgEntryPrice: 1, currentPrice: 1, status: 'CLOSED', mode: 'PAPER', openedAt: new Date(base + (index + 1) * 1_000), closedAt: new Date(base + (index + 2) * 1_000) } });
    }
    const list = await agent.get('/api/positions');
    expect(list.body.data.filter((row: { status: string }) => row.status === 'OPEN')).toHaveLength(1);
    expect(list.body.data.filter((row: { status: string }) => row.status === 'CLOSED')).toHaveLength(25);
    const onlyOpen = await agent.get('/api/positions?status=OPEN');
    expect(onlyOpen.body.data).toHaveLength(1);
  });
});
