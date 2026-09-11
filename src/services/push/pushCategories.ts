// v126-push-categories
// Single source of truth for actionable push notification categories.
// The server stamps every push with a category id and a deep-link target.
// Native clients register matching categories so iOS/Android can render the
// action buttons without waking the app.

export type PushActionId =
  | 'UPLOAD_NOW'
  | 'OPEN_APPLICATION'
  | 'CALL_BACK'
  | 'CREATE_FOLLOWUP'
  | 'VIEW_OFFER'
  | 'DISMISS';

export type PushAction = {
  id: PushActionId;
  title: string;
  destructive: boolean;
  authenticationRequired: boolean;
  foreground: boolean;
};

export type PushCategoryId =
  | 'DOCUMENT_REQUEST'
  | 'APPLICATION_UPDATE'
  | 'OFFER_READY'
  | 'MISSED_CALL'
  | 'TASK_DUE'
  | 'GENERIC';

export type PushCategory = {
  id: PushCategoryId;
  actions: PushAction[];
  /** Route template resolved against the payload's entity id. */
  route: string;
};

function action(
  id: PushActionId,
  title: string,
  opts: Partial<Omit<PushAction, 'id' | 'title'>> = {},
): PushAction {
  return {
    id,
    title,
    destructive: opts.destructive === true,
    authenticationRequired: opts.authenticationRequired !== false,
    foreground: opts.foreground !== false,
  };
}

export const PUSH_CATEGORIES: Record<PushCategoryId, PushCategory> = {
  DOCUMENT_REQUEST: {
    id: 'DOCUMENT_REQUEST',
    route: '/applications/:entityId/documents',
    actions: [action('UPLOAD_NOW', 'Upload Now'), action('OPEN_APPLICATION', 'Open Application')],
  },
  APPLICATION_UPDATE: {
    id: 'APPLICATION_UPDATE',
    route: '/applications/:entityId',
    actions: [action('OPEN_APPLICATION', 'Open Application')],
  },
  OFFER_READY: {
    id: 'OFFER_READY',
    route: '/applications/:entityId/offer',
    actions: [action('VIEW_OFFER', 'View Offer'), action('OPEN_APPLICATION', 'Open Application')],
  },
  MISSED_CALL: {
    id: 'MISSED_CALL',
    route: '/crm/contacts/:entityId',
    actions: [action('CALL_BACK', 'Call Back'), action('CREATE_FOLLOWUP', 'Create Follow-up')],
  },
  TASK_DUE: {
    id: 'TASK_DUE',
    route: '/tasks/:entityId',
    actions: [action('CREATE_FOLLOWUP', 'Create Follow-up'), action('DISMISS', 'Dismiss', { foreground: false })],
  },
  GENERIC: {
    id: 'GENERIC',
    route: '/',
    actions: [],
  },
};

export function getCategory(id: string | null | undefined): PushCategory {
  const key = String(id || '').toUpperCase() as PushCategoryId;
  return PUSH_CATEGORIES[key] || PUSH_CATEGORIES.GENERIC;
}

export function buildDeepLink(categoryId: string | null | undefined, entityId: string | null | undefined): string {
  const category = getCategory(categoryId);
  const id = String(entityId || '').trim();
  if (!id) return category.route.replace(/\/:entityId.*$/, '') || '/';
  return category.route.replace(':entityId', encodeURIComponent(id));
}

export type PushEnvelopeInput = {
  categoryId?: string | null;
  entityId?: string | null;
  title: string;
  body: string;
  silo?: string | null;
  data?: Record<string, string>;
};

/**
 * Builds the FCM message body. apns.payload.aps.category drives the iOS
 * action buttons; android.notification.clickAction drives the Android intent
 * filter. Both carry the same deep link in data so the app can route on tap.
 */
export function buildPushEnvelope(input: PushEnvelopeInput) {
  const category = getCategory(input.categoryId);
  const link = buildDeepLink(category.id, input.entityId);
  const data: Record<string, string> = {
    ...(input.data || {}),
    categoryId: category.id,
    deepLink: link,
  };
  if (input.entityId) data.entityId = String(input.entityId);
  if (input.silo) data.silo = String(input.silo);

  return {
    notification: { title: input.title, body: input.body },
    data,
    apns: {
      payload: {
        aps: {
          category: category.id,
          'mutable-content': 1,
          sound: 'default',
        },
      },
    },
    android: {
      notification: {
        clickAction: 'BOREAL_NOTIFICATION_CLICK',
        channelId: category.id === 'MISSED_CALL' ? 'calls' : 'default',
      },
    },
  };
}

/** Emitted to clients so they register exactly what the server sends. */
export function categoryManifest() {
  return Object.values(PUSH_CATEGORIES).map((c) => ({
    id: c.id,
    route: c.route,
    actions: c.actions.map((a) => ({
      id: a.id,
      title: a.title,
      destructive: a.destructive,
      authenticationRequired: a.authenticationRequired,
      foreground: a.foreground,
    })),
  }));
}
