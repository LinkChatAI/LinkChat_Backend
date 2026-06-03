import {
  addScreenShareRequest,
  clearScreenShareState,
  getScreenSharePublicState,
  removeScreenShareParticipant,
  setScreenSharePresenter,
  updateScreenShareSettings,
} from './screenShareState.js';

describe('screenShareState', () => {
  const room = 'TEST';

  beforeEach(() => {
    clearScreenShareState(room);
  });

  it('tracks pending requests and presenter', () => {
    const req = addScreenShareRequest(room, 'user-a', 'Alice');
    expect(req.ok).toBe(true);

    setScreenSharePresenter(room, 'user-a', 'Alice');
    const state = getScreenSharePublicState(room);
    expect(state.presenterId).toBe('user-a');
    expect(state.pendingRequests).toHaveLength(0);
  });

  it('rejects duplicate pending requests', () => {
    addScreenShareRequest(room, 'user-b', 'Bob');
    const dup = addScreenShareRequest(room, 'user-b', 'Bob');
    expect(dup.ok).toBe(false);
    if (!dup.ok) expect(dup.code).toBe('pending_exists');
  });

  it('clears presenter when participant leaves', () => {
    setScreenSharePresenter(room, 'user-c', 'Carol');
    const left = removeScreenShareParticipant(room, 'user-c');
    expect(left.wasPresenter).toBe(true);
    expect(getScreenSharePublicState(room).presenterId).toBeNull();
  });

  it('respects disabled setting', () => {
    updateScreenShareSettings(room, { enabled: false });
    const result = addScreenShareRequest(room, 'user-d', 'Dan');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('disabled');
  });
});
