export interface ScreenShareRequest {
  userId: string;
  nickname: string;
  requestedAt: number;
}

export interface RoomScreenShareSettings {
  enabled: boolean;
  moderatorsOnly: boolean;
}

export interface RoomScreenSharePublicState {
  settings: RoomScreenShareSettings;
  presenterId: string | null;
  presenterNickname: string | null;
  pendingRequests: ScreenShareRequest[];
  queue: string[];
}

export type AddScreenShareRequestResult =
  | { ok: true }
  | { ok: false; reason: string; code: 'disabled' | 'moderators_only' | 'already_presenting' | 'queued' | 'pending_exists' | 'invalid' };

interface RoomScreenShareInternal {
  settings: RoomScreenShareSettings;
  presenterId: string | null;
  presenterNickname: string | null;
  pendingRequests: Map<string, ScreenShareRequest>;
  queue: string[];
}

const roomStates = new Map<string, RoomScreenShareInternal>();
const MAX_NICKNAME_LEN = 64;
const MAX_USER_ID_LEN = 128;

const defaultSettings = (): RoomScreenShareSettings => ({
  enabled: true,
  moderatorsOnly: false,
});

const sanitizeUserId = (userId: string): string | null => {
  const trimmed = userId?.trim();
  if (!trimmed || trimmed.length > MAX_USER_ID_LEN) return null;
  return trimmed;
};

const sanitizeNickname = (nickname: string): string => {
  const trimmed = (nickname || 'Anonymous').trim().slice(0, MAX_NICKNAME_LEN);
  return trimmed || 'Anonymous';
};

const getOrCreateInternal = (roomCode: string): RoomScreenShareInternal => {
  let state = roomStates.get(roomCode);
  if (!state) {
    state = {
      settings: defaultSettings(),
      presenterId: null,
      presenterNickname: null,
      pendingRequests: new Map(),
      queue: [],
    };
    roomStates.set(roomCode, state);
  }
  return state;
};

export const getScreenSharePublicState = (roomCode: string): RoomScreenSharePublicState => {
  const state = getOrCreateInternal(roomCode);
  return {
    settings: { ...state.settings },
    presenterId: state.presenterId,
    presenterNickname: state.presenterNickname,
    pendingRequests: Array.from(state.pendingRequests.values()),
    queue: [...state.queue],
  };
};

export const clearScreenShareState = (roomCode: string): void => {
  roomStates.delete(roomCode);
};

export const hasScreenShareState = (roomCode: string): boolean => roomStates.has(roomCode);

export const updateScreenShareSettings = (
  roomCode: string,
  partial: Partial<RoomScreenShareSettings>
): RoomScreenShareSettings => {
  const state = getOrCreateInternal(roomCode);
  state.settings = { ...state.settings, ...partial };
  return { ...state.settings };
};

export const hasPendingScreenShareRequest = (roomCode: string, userId: string): boolean => {
  const state = roomStates.get(roomCode);
  return state?.pendingRequests.has(userId) ?? false;
};

export const addScreenShareRequest = (
  roomCode: string,
  userId: string,
  nickname: string
): AddScreenShareRequestResult => {
  const safeUserId = sanitizeUserId(userId);
  if (!safeUserId) {
    return { ok: false, reason: 'Invalid user', code: 'invalid' };
  }

  const state = getOrCreateInternal(roomCode);

  if (!state.settings.enabled) {
    return { ok: false, reason: 'Screen sharing is disabled in this room', code: 'disabled' };
  }
  if (state.settings.moderatorsOnly) {
    return { ok: false, reason: 'Only the room host can share their screen', code: 'moderators_only' };
  }
  if (state.presenterId) {
    if (state.presenterId === safeUserId) {
      return { ok: false, reason: 'You are already presenting', code: 'already_presenting' };
    }
    if (!state.queue.includes(safeUserId)) {
      state.queue.push(safeUserId);
    }
    return {
      ok: false,
      reason: 'Someone is already presenting. You have been added to the queue.',
      code: 'queued',
    };
  }
  if (state.pendingRequests.has(safeUserId)) {
    return { ok: false, reason: 'You already have a pending request', code: 'pending_exists' };
  }

  state.pendingRequests.set(safeUserId, {
    userId: safeUserId,
    nickname: sanitizeNickname(nickname),
    requestedAt: Date.now(),
  });
  return { ok: true };
};

export const removeScreenShareRequest = (roomCode: string, userId: string): void => {
  const safeUserId = sanitizeUserId(userId);
  if (!safeUserId) return;
  const state = roomStates.get(roomCode);
  if (!state) return;
  state.pendingRequests.delete(safeUserId);
  state.queue = state.queue.filter((id) => id !== safeUserId);
};

export const setScreenSharePresenter = (
  roomCode: string,
  userId: string,
  nickname: string
): void => {
  const safeUserId = sanitizeUserId(userId);
  if (!safeUserId) return;
  const state = getOrCreateInternal(roomCode);
  state.presenterId = safeUserId;
  state.presenterNickname = sanitizeNickname(nickname);
  state.pendingRequests.delete(safeUserId);
  state.queue = state.queue.filter((id) => id !== safeUserId);
};

export const clearScreenSharePresenter = (roomCode: string): string | null => {
  const state = roomStates.get(roomCode);
  if (!state) return null;
  const previousPresenter = state.presenterId;
  state.presenterId = null;
  state.presenterNickname = null;
  return previousPresenter;
};

export const getScreenSharePresenter = (roomCode: string): string | null => {
  return roomStates.get(roomCode)?.presenterId ?? null;
};

/** Remove user from queue/requests; clear presenter if they were presenting. */
export const removeScreenShareParticipant = (
  roomCode: string,
  userId: string
): { wasPresenter: boolean; presenterId: string | null } => {
  const safeUserId = sanitizeUserId(userId);
  if (!safeUserId) return { wasPresenter: false, presenterId: null };

  const state = roomStates.get(roomCode);
  if (!state) return { wasPresenter: false, presenterId: null };

  state.pendingRequests.delete(safeUserId);
  state.queue = state.queue.filter((id) => id !== safeUserId);

  if (state.presenterId === safeUserId) {
    state.presenterId = null;
    state.presenterNickname = null;
    return { wasPresenter: true, presenterId: safeUserId };
  }
  return { wasPresenter: false, presenterId: null };
};
