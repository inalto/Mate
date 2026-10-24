import { useCallback, useEffect, useRef, useState } from "react";
import {
  nextcloudLoginPoll,
  nextcloudLoginStart,
  nextcloudLogout,
  nextcloudStatus,
  type NextcloudStatus,
} from "../../../ipc/share";
import { Row, SettingsSection } from "../rows";

export const POLL_MS = 2000;

const message = (err: unknown): string =>
  typeof err === "string" ? err : err instanceof Error ? err.message : "Something went wrong.";

export default function SharingSection() {
  const [status, setStatus] = useState<NextcloudStatus | null>(null);
  const [server, setServer] = useState("");
  const [waiting, setWaiting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const attempt = useRef(0);

  const stopPolling = useCallback(() => {
    attempt.current += 1; // invalidates any poll in flight
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  }, []);

  const refresh = useCallback(
    () =>
      nextcloudStatus().then(
        setStatus,
        () => setStatus({ signedIn: false, server: "", user: "" }),
      ),
    [],
  );

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- loads the saved sign-in from the backend
    void refresh();
    return stopPolling;
  }, [refresh, stopPolling]);

  const signIn = async () => {
    setError(null);
    stopPolling();
    const id = attempt.current;
    try {
      await nextcloudLoginStart(server.trim());
    } catch (err) {
      setError(message(err));
      return;
    }
    setWaiting(true);
    const tick = async () => {
      try {
        const { done } = await nextcloudLoginPoll();
        if (attempt.current !== id) return;
        if (done) {
          setWaiting(false);
          await refresh();
          return;
        }
      } catch (err) {
        if (attempt.current !== id) return;
        setWaiting(false);
        setError(message(err));
        return;
      }
      timer.current = setTimeout(() => void tick(), POLL_MS);
    };
    timer.current = setTimeout(() => void tick(), POLL_MS);
  };

  const cancel = () => {
    stopPolling();
    setWaiting(false);
  };

  const signOut = async () => {
    setError(null);
    try {
      await nextcloudLogout();
      await refresh();
    } catch (err) {
      setError(message(err));
    }
  };

  return (
    <SettingsSection id="sharing" title="Sharing">
      <Row id="sharing-nextcloud" label="Nextcloud" hint="Upload a book to your Nextcloud and get a link to send to someone.">
        {status?.signedIn ? (
          <>
            <span>Signed in as {status.user} on {status.server}</span>
            <button type="button" className="btn" onClick={() => void signOut()}>
              Sign out
            </button>
          </>
        ) : waiting ? (
          <>
            <span role="status">Waiting for you to approve in your browser…</span>
            <button type="button" className="btn" onClick={cancel}>
              Cancel
            </button>
          </>
        ) : (
          <>
            <input
              className="input"
              type="url"
              aria-label="Nextcloud server address"
              placeholder="https://cloud.example.com"
              value={server}
              onChange={(e) => setServer(e.target.value)}
            />
            <button type="button" className="btn" disabled={!server.trim()} onClick={() => void signIn()}>
              Sign in
            </button>
          </>
        )}
      </Row>
      <p className="form-error" role="alert" hidden={!error}>
        {error}
      </p>
    </SettingsSection>
  );
}
