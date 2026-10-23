// app.tsx — minimal app state: which screen, the connected UP session, and
// whether we've announced our conv key.
import { createContext, useContext, useEffect, useMemo, useReducer, type ReactNode } from 'react';
import { watchUpSession, type UpSession } from '../lib/up';

export type Screen = 'connect' | 'announce' | 'wall';

export interface AppState {
  screen: Screen;
  up: UpSession | null;
  announced: boolean;
}

type Action =
  | { type: 'connected'; up: UpSession }
  | { type: 'needAnnounce' }
  /** `up` = the session the announce ran for; ignored if it's no longer current. */
  | { type: 'announced'; up: UpSession }
  | { type: 'goWall' }
  | { type: 'disconnect' };

const initial: AppState = { screen: 'connect', up: null, announced: false };

function reducer(s: AppState, a: Action): AppState {
  switch (a.type) {
    case 'connected':
      return { ...s, up: a.up, announced: false, screen: 'announce' };
    // Screen moves need a live session: an announce that finishes after a
    // disconnect (or for a since-replaced session) must not reach the wall.
    case 'needAnnounce':
      return s.up ? { ...s, screen: 'announce' } : s;
    case 'announced':
      return s.up && s.up === a.up ? { ...s, announced: true, screen: 'wall' } : s;
    case 'goWall':
      return s.up ? { ...s, screen: 'wall' } : s;
    case 'disconnect':
      return initial;
    default:
      return s;
  }
}

const Ctx = createContext<{ state: AppState; dispatch: (a: Action) => void } | null>(null);

export function AppProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, initial);
  // A wallet disconnect or account/chain switch invalidates the signer and conv
  // key: drop the session and go back to the connect screen.
  useEffect(() => {
    if (!state.up) return;
    return watchUpSession(state.up, () => dispatch({ type: 'disconnect' }));
  }, [state.up]);
  const value = useMemo(() => ({ state, dispatch }), [state]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useApp() {
  const v = useContext(Ctx);
  if (!v) throw new Error('useApp outside provider');
  return v;
}
