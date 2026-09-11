import { describe, it, expect } from 'vitest';
import {
  PUSH_CATEGORIES,
  getCategory,
  buildDeepLink,
  buildPushEnvelope,
  categoryManifest,
} from '../services/push/pushCategories';

describe('v126 push categories', () => {
  it('falls back to GENERIC for unknown ids', () => {
    expect(getCategory('nope').id).toBe('GENERIC');
    expect(getCategory(null).id).toBe('GENERIC');
    expect(getCategory('document_request').id).toBe('DOCUMENT_REQUEST');
  });

  it('builds deep links with the entity id', () => {
    expect(buildDeepLink('DOCUMENT_REQUEST', 'abc-123')).toBe('/applications/abc-123/documents');
    expect(buildDeepLink('MISSED_CALL', 'c1')).toBe('/crm/contacts/c1');
  });

  it('degrades to a list route when there is no entity id', () => {
    expect(buildDeepLink('APPLICATION_UPDATE', '')).toBe('/applications');
    expect(buildDeepLink('GENERIC', '')).toBe('/');
  });

  it('escapes entity ids', () => {
    expect(buildDeepLink('APPLICATION_UPDATE', 'a/b')).toBe('/applications/a%2Fb');
  });

  it('stamps the apns category so iOS renders actions', () => {
    const env = buildPushEnvelope({
      categoryId: 'DOCUMENT_REQUEST',
      entityId: 'app-9',
      title: 'Document required',
      body: 'March bank statement',
      silo: 'BF',
    });
    expect(env.apns.payload.aps.category).toBe('DOCUMENT_REQUEST');
    expect(env.data.deepLink).toBe('/applications/app-9/documents');
    expect(env.data.categoryId).toBe('DOCUMENT_REQUEST');
    expect(env.data.silo).toBe('BF');
    expect(env.notification.title).toBe('Document required');
  });

  it('routes missed calls to the calls channel on android', () => {
    const env = buildPushEnvelope({ categoryId: 'MISSED_CALL', entityId: 'c7', title: 'Missed call', body: 'Walter' });
    expect(env.android.notification.channelId).toBe('calls');
    expect(env.android.notification.clickAction).toBe('BOREAL_NOTIFICATION_CLICK');
  });

  it('every non-generic category has at least one action', () => {
    for (const c of Object.values(PUSH_CATEGORIES)) {
      if (c.id === 'GENERIC') continue;
      expect(c.actions.length).toBeGreaterThan(0);
    }
  });

  it('every category route carries an entity placeholder except GENERIC', () => {
    for (const c of Object.values(PUSH_CATEGORIES)) {
      if (c.id === 'GENERIC') continue;
      expect(c.route).toContain(':entityId');
    }
  });

  it('manifest is serialisable and complete', () => {
    const m = categoryManifest();
    expect(m.length).toBe(Object.keys(PUSH_CATEGORIES).length);
    expect(JSON.parse(JSON.stringify(m))).toEqual(m);
  });

  it('preserves caller data without letting it override the category', () => {
    const env = buildPushEnvelope({
      categoryId: 'OFFER_READY',
      entityId: 'x1',
      title: 't',
      body: 'b',
      data: { categoryId: 'HACKED', custom: 'kept' },
    });
    expect(env.data.categoryId).toBe('OFFER_READY');
    expect(env.data.custom).toBe('kept');
  });
});
